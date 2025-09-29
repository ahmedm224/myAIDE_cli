import { Agent, AgentStatus, type AgentResult } from "./agent-base";
import type { ShellTool } from "../tools/shell";

export class ValidatorAgent extends Agent {
  readonly name = "validator";
  readonly description = "Runs automated checks (tests, linting) to validate changes.";
  private readonly command?: string[];

  constructor(context: ConstructorParameters<typeof Agent>[0], command?: string[]) {
    super(context);
    this.command = command;
  }

  async run(): Promise<AgentResult> {
    const shell = this.context.shell;
    if (!shell) {
      return { agent: this.name, status: AgentStatus.Skipped, summary: "Shell tool unavailable." };
    }

    const command = this.command ?? this.inferCommand();
    if (!command) {
      return { agent: this.name, status: AgentStatus.Skipped, summary: "No validation command configured." };
    }

    try {
      const [exec, ...args] = command;
      const result = await shell.run(exec, args);
      return {
        agent: this.name,
        status: AgentStatus.Success,
        summary: `Validation succeeded (exit ${result.exitCode}).`,
        details: result.stdout
      };
    } catch (error) {
      return {
        agent: this.name,
        status: AgentStatus.Failure,
        summary: (error as Error).message
      };
    }
  }

  private inferCommand(): string[] | undefined {
    const hint = this.context.artifacts["validation_hint"];
    if (Array.isArray(hint) && hint.every((item) => typeof item === "string")) {
      return hint as string[];
    }
    return undefined;
  }
}
