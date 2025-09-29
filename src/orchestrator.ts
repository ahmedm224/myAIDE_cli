import { loadSettings, type Settings } from "./config/settings";
import {
  Agent,
  AgentStatus,
  type AgentContext,
  type AgentResult,
  AnalyzerAgent,
  ImplementerAgent,
  PlannerAgent,
  ReporterAgent,
  ValidatorAgent,
  TestGeneratorAgent,
  OptimizerAgent,
  type ConversationTurn,
  type TokenUsage
} from "./agents";
import { FileSystemTool, type MutationConfirm } from "./tools/filesystem";
import { ShellTool } from "./tools/shell";
import { MyAIDEManager } from "./context/myaide-manager";

export type AgentFactory = (context: AgentContext) => Agent;

export interface OrchestratorConfig {
  validationCommand?: string[];
  agents?: AgentFactory[];
  mutationConfirm?: MutationConfirm;
}

export interface OrchestratorObservers {
  onAgentStart?: (agentName: string) => void;
  onAgentFinish?: (result: AgentResult) => void;
  onMyAIDEStatus?: (message: string) => void;
}

export interface OrchestratorRunResult {
  results: AgentResult[];
  usage: TokenUsage;
  context: AgentContext;
  myAIDEGenerated?: boolean;
  myAIDEContent?: string;
}

export class Orchestrator {
  private readonly settings: Settings;
  private readonly config: OrchestratorConfig;

  constructor(settings?: Settings, config?: OrchestratorConfig) {
    this.settings = settings ?? loadSettings();
    this.config = config ?? {};
  }

  async run(
    request: string,
    observers?: OrchestratorObservers,
    memory: ConversationTurn[] = [],
    artifacts: Record<string, unknown> = {},
    skipMyAIDECheck = false
  ): Promise<OrchestratorRunResult> {
    let myAIDEGenerated = false;
    let myAIDEContent: string | undefined;

    // Handle myAIDE.md lifecycle BEFORE running agents (unless skipped)
    if (!skipMyAIDECheck) {
      const myAIDEResult = await this.handleMyAIDE(observers);
      myAIDEGenerated = myAIDEResult.generated;
      myAIDEContent = myAIDEResult.content;

      // Inject myAIDE.md content into artifacts for agent consumption
      if (myAIDEContent) {
        artifacts["myAIDEContent"] = myAIDEContent;
      }
    }

    const context = this.buildContext(request, memory, artifacts);
    const results = await this.runOptimizedPipeline(context, observers);

    return { results, usage: context.usage, context, myAIDEGenerated, myAIDEContent };
  }

  private async runOptimizedPipeline(
    context: AgentContext,
    observers?: OrchestratorObservers
  ): Promise<AgentResult[]> {
    const results: AgentResult[] = [];

    // PHASE 1: Planning (sequential, required)
    const planner = new PlannerAgent(context);
    observers?.onAgentStart?.(planner.name);
    const planResult = await planner.run();
    context.registerResult(planResult);
    results.push(planResult);
    observers?.onAgentFinish?.(planResult);

    // PHASE 2: Implementation (sequential, required)
    const implementer = new ImplementerAgent(context);
    observers?.onAgentStart?.(implementer.name);
    const implResult = await implementer.run();
    context.registerResult(implResult);
    results.push(implResult);
    observers?.onAgentFinish?.(implResult);

    // Skip remaining phases if implementation failed
    if (implResult.status === AgentStatus.Failure) {
      const reporter = new ReporterAgent(context);
      observers?.onAgentStart?.(reporter.name);
      const reportResult = await reporter.run();
      context.registerResult(reportResult);
      results.push(reportResult);
      observers?.onAgentFinish?.(reportResult);
      return results;
    }

    // PHASE 3: Analysis & Quality (parallel execution for speed)
    const parallelAgents = [
      new AnalyzerAgent(context),
      new TestGeneratorAgent(context),
      new OptimizerAgent(context)
    ];

    const parallelPromises = parallelAgents.map(async (agent) => {
      observers?.onAgentStart?.(agent.name);
      const result = await agent.run();
      context.registerResult(result);
      observers?.onAgentFinish?.(result);
      return result;
    });

    const parallelResults = await Promise.all(parallelPromises);
    results.push(...parallelResults);

    // PHASE 4: Validation (sequential, after all code changes)
    const validator = new ValidatorAgent(context, this.config.validationCommand);
    observers?.onAgentStart?.(validator.name);
    const valResult = await validator.run();
    context.registerResult(valResult);
    results.push(valResult);
    observers?.onAgentFinish?.(valResult);

    // PHASE 5: Reporting (sequential, final summary)
    const reporter = new ReporterAgent(context);
    observers?.onAgentStart?.(reporter.name);
    const reportResult = await reporter.run();
    context.registerResult(reportResult);
    results.push(reportResult);
    observers?.onAgentFinish?.(reportResult);

    return results;
  }

  private async handleMyAIDE(observers?: OrchestratorObservers): Promise<{ generated: boolean; content?: string }> {
    const manager = new MyAIDEManager(this.settings.runtime.workspaceRoot, this.settings);

    try {
      const status = await manager.getStatus();

      // Scenario 1: myAIDE.md doesn't exist - generate it
      if (!status.exists) {
        observers?.onMyAIDEStatus?.("myAIDE.md not found. Analyzing workspace to create it...");
        const result = await manager.generate();
        await manager.write(result.content);
        observers?.onMyAIDEStatus?.(`myAIDE.md created (${result.usage.prompt + result.usage.completion} tokens used).`);
        return { generated: true, content: result.content };
      }

      // Scenario 2: myAIDE.md exists - read and check for updates
      const content = await manager.read();
      if (!content) {
        // Shouldn't happen, but handle gracefully
        return { generated: false };
      }

      observers?.onMyAIDEStatus?.("myAIDE.md found. Checking for significant workspace changes...");

      const needsUpdate = await manager.detectNeedsUpdate();
      if (needsUpdate) {
        observers?.onMyAIDEStatus?.(
          "Significant changes detected in workspace configuration. Consider regenerating myAIDE.md with '/refresh-myaide' command."
        );
      } else {
        observers?.onMyAIDEStatus?.("myAIDE.md is up to date.");
      }

      // Scenario 3: Read existing myAIDE.md into context
      return { generated: false, content };
    } catch (error) {
      observers?.onMyAIDEStatus?.(`myAIDE.md handling error: ${(error as Error).message}`);
      return { generated: false };
    }
  }

  private buildContext(
    request: string,
    memory: ConversationTurn[],
    artifacts: Record<string, unknown>
  ): AgentContext {
    const { runtime } = this.settings;
    const fsTool = new FileSystemTool({
      root: runtime.workspaceRoot,
      dryRun: runtime.dryRun,
      confirm: this.config.mutationConfirm
    });
    const shellTool = new ShellTool({ cwd: runtime.workspaceRoot, shell: true });

    const history: AgentResult[] = [];

    const context: AgentContext = {
      request,
      workspace: runtime.workspaceRoot,
      settings: this.settings,
      plan: [],
      artifacts: { ...artifacts },
      history,
      filesystem: fsTool,
      shell: shellTool,
      memory: [...memory],
      usage: { prompt: 0, completion: 0 },
      registerResult: (result: AgentResult) => {
        history.push(result);
      }
    };

    return context;
  }

  private defaultPipeline(): AgentFactory[] {
    return [
      (context) => new PlannerAgent(context),
      (context) => new ImplementerAgent(context),
      (context) => new AnalyzerAgent(context),
      (context) => new ValidatorAgent(context, this.config.validationCommand),
      (context) => new ReporterAgent(context)
    ];
  }
}
