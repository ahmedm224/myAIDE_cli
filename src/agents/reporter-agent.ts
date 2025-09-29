import { Agent, AgentStatus, type AgentResult } from "./agent-base";

export class ReporterAgent extends Agent {
  readonly name = "reporter";
  readonly description = "Summarizes agent results for the user.";

  async run(): Promise<AgentResult> {
    if (!this.context.history.length) {
      return { agent: this.name, status: AgentStatus.Skipped, summary: "No agent history to report." };
    }

    const lines: string[] = ["Execution report:"];
    for (const entry of this.context.history) {
      const mark = entry.status === AgentStatus.Success ? "✔" : entry.status === AgentStatus.Failure ? "✖" : "➖";
      lines.push(`  ${mark} ${entry.agent}: ${entry.summary}`);
    }

    return {
      agent: this.name,
      status: AgentStatus.Success,
      summary: "Reported execution summary.",
      details: lines.join("\n")
    };
  }
}
