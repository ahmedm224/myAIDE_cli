import { Agent, AgentStatus, type AgentResult } from "./agent-base";
import { LLMClient, type ChatMessage } from "../llm/openai-client";

const SYSTEM_PROMPT = `You are a code optimization specialist in a multi-agent coding assistant.
Your job is to identify performance bottlenecks, memory leaks, and optimization opportunities in the implemented code.

RULES:
1. Analyze implementation changes for performance issues
2. Identify inefficient algorithms, unnecessary re-renders, memory leaks, N+1 queries
3. Suggest concrete optimizations with code examples
4. Consider the project's tech stack and constraints
5. Prioritize high-impact, low-risk optimizations

Return a structured analysis in markdown format with sections:
- **Critical Issues** (must fix)
- **Performance Opportunities** (should consider)
- **Minor Improvements** (nice to have)

Be specific with file paths and line references.`;

export class OptimizerAgent extends Agent {
  readonly name = "optimizer";
  readonly description = "Analyzes code for performance bottlenecks and optimization opportunities.";

  async run(): Promise<AgentResult> {
    // Skip if no mutations occurred
    const mutations = this.context.history.find((r) => r.mutations)?.mutations;
    if (!mutations || mutations.length === 0) {
      return {
        agent: this.name,
        status: AgentStatus.Skipped,
        summary: "No code changes to optimize."
      };
    }

    // Skip for trivial changes (1-2 small files)
    const totalChangedLines = mutations.reduce((sum, m) => {
      const lines = (m.after?.split("\n").length || 0) - (m.before?.split("\n").length || 0);
      return sum + Math.abs(lines);
    }, 0);

    if (totalChangedLines < 20) {
      return {
        agent: this.name,
        status: AgentStatus.Skipped,
        summary: "Changes too small to warrant optimization analysis."
      };
    }

    try {
      const client = new LLMClient(this.context.settings);
      const myAIDEContent = this.getMyAIDEContent();
      const changesSummary = this.buildChangesSummary(mutations);

      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            `USER REQUEST: ${this.context.request}`,
            myAIDEContent ? `\nPROJECT CONTEXT:\n${myAIDEContent}` : "",
            `\nCODE CHANGES:\n${changesSummary}`,
            "\nAnalyze for performance issues and optimization opportunities:"
          ]
            .filter(Boolean)
            .join("\n")
        }
      ];

      const completion = await client.complete(messages, {
        temperature: 0.2,
        maxOutputTokens: 2000
      });

      this.context.usage.prompt += completion.usagePromptTokens ?? 0;
      this.context.usage.completion += completion.usageCompletionTokens ?? 0;

      const analysis = completion.content.trim();
      const hasCriticalIssues = analysis.toLowerCase().includes("critical");

      return {
        agent: this.name,
        status: hasCriticalIssues ? AgentStatus.Success : AgentStatus.Success,
        summary: hasCriticalIssues
          ? "⚠️ Critical performance issues found - review recommended"
          : "Code performance analysis complete - minor opportunities identified",
        details: analysis
      };
    } catch (error) {
      return {
        agent: this.name,
        status: AgentStatus.Failure,
        summary: `Optimization analysis failed: ${(error as Error).message}`
      };
    }
  }

  private getMyAIDEContent(): string {
    const content = this.context.artifacts["myAIDEContent"] as string | undefined;
    if (content) {
      return content.length > 1000 ? content.slice(0, 1000) + "\n..." : content;
    }
    return "";
  }

  private buildChangesSummary(mutations: Array<{ path: string; before?: string; after?: string }>): string {
    const summaries: string[] = [];

    for (const mutation of mutations.slice(0, 5)) {
      const beforeLines = mutation.before?.split("\n").length || 0;
      const afterLines = mutation.after?.split("\n").length || 0;
      const delta = afterLines - beforeLines;

      summaries.push(`File: ${mutation.path} (${delta >= 0 ? "+" : ""}${delta} lines)`);

      if (mutation.after) {
        // Show a snippet of the new code
        const snippet = mutation.after.split("\n").slice(0, 30).join("\n");
        summaries.push(`\`\`\`\n${snippet}\n...\n\`\`\``);
      }
    }

    return summaries.join("\n\n");
  }
}