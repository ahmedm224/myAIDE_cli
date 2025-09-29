import { Agent, AgentStatus, type AgentResult } from "./agent-base";
import { LLMClient } from "../llm/openai-client";
import type { FileSystemTool } from "../tools/filesystem";

const SYSTEM_PROMPT = `You are the analyzer agent. Review the provided file snapshots and highlight potential risks.
Focus on correctness bugs, missing tests, and edge cases. Respond with bullet points.
If no material risks are found, state that explicitly.`;

interface ImplementationArtifacts {
  actions?: { path?: string }[];
}

export class AnalyzerAgent extends Agent {
  readonly name = "analyzer";
  readonly description = "Audits implemented changes for potential risks.";

  async run(): Promise<AgentResult> {
    const fsTool = this.context.filesystem;
    const implementation = this.context.artifacts["implementation"] as ImplementationArtifacts | undefined;

    if (!fsTool || !implementation) {
      return { agent: this.name, status: AgentStatus.Skipped, summary: "No implementation output to analyze." };
    }

    const changedPaths = (implementation.actions ?? [])
      .map((action) => action.path)
      .filter((p): p is string => Boolean(p));

    if (!changedPaths.length) {
      return { agent: this.name, status: AgentStatus.Skipped, summary: "No changed files detected." };
    }

    if (!this.context.settings.openAiApiKey) {
      return { agent: this.name, status: AgentStatus.Failure, summary: "Missing OPENAI_API_KEY; analysis skipped." };
    }

    try {
      const bundle = await this.collectSnapshots(fsTool, changedPaths);
      const client = new LLMClient(this.context.settings);
      const completion = await client.complete([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: this.buildPrompt(bundle) }
      ]);
      this.context.usage.prompt += completion.usagePromptTokens ?? 0;
      this.context.usage.completion += completion.usageCompletionTokens ?? 0;

      return {
        agent: this.name,
        status: AgentStatus.Success,
        summary: "Provided risk analysis.",
        details: completion.content
      };
    } catch (error) {
      return {
        agent: this.name,
        status: AgentStatus.Failure,
        summary: (error as Error).message
      };
    }
  }

  private async collectSnapshots(fsTool: FileSystemTool, paths: string[]): Promise<string> {
    const sections: string[] = [];
    for (const relPath of paths) {
      try {
        const content = await fsTool.read(relPath);
        sections.push(`## ${relPath}\n\n\`\`\`\n${content}\n\`\`\``);
      } catch {
        // File may have been deleted; skip silently.
      }
    }
    return sections.join("\n\n");
  }

  private buildPrompt(snapshots: string): string {
    const planSection = this.context.plan.length
      ? this.context.plan.map((step) => `- ${step}`).join("\n")
      : "- No plan recorded";
    const snapshotSection = snapshots || "No file snapshots available.";

    const memory = this.context.memory
      .slice(-4)
      .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`)
      .join("\n");

    const sections = [
      `User request: ${this.context.request}`,
      `Execution plan:\n${planSection}`,
      memory ? `Recent conversation:\n${memory}` : "",
      `File snapshots:\n${snapshotSection}`
    ];

    return sections.filter(Boolean).join("\n\n");
  }
}
