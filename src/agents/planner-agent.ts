import { Agent, AgentStatus, type AgentResult } from "./agent-base";
import { LLMClient } from "../llm/openai-client";
import type { ChatMessage } from "../llm/openai-client";
import { buildWorkspaceSummary } from "../context/workspace-summary";

const SYSTEM_PROMPT = `You are the planning agent in a multi-agent coding assistant.
Your job is to create a SPECIFIC, CONCRETE todo list for the user's request.

CRITICAL RULES:
1. Each step must be a CONCRETE action item that directly addresses the user's request
2. Focus ONLY on what the user asked for - no generic prerequisites, testing, or validation steps
3. Be SPECIFIC about files, functions, and changes (e.g., "Add login() method to src/auth/user.ts", NOT "Implement authentication")
4. Steps should map 1:1 to actual code changes or file operations
5. Limit to 4-6 steps - each step should be a distinct deliverable
6. NO generic steps like "Review code", "Add tests", "Update documentation", "Ensure quality"
7. Use action verbs: "Add", "Modify", "Delete", "Create", "Update", "Rename", "Refactor"

BAD EXAMPLES (too generic):
❌ "Set up authentication system"
❌ "Implement error handling"
❌ "Add necessary tests"
❌ "Review and refine implementation"

GOOD EXAMPLES (specific and concrete):
✅ "Create src/components/LoginForm.tsx with email/password inputs"
✅ "Add authenticateUser() function to src/api/auth.ts"
✅ "Modify src/App.tsx to import and render LoginForm"
✅ "Create POST /api/login endpoint in src/routes/auth.ts"

Return ONLY a numbered list (1-6 items). No explanations, no preamble.`;

export class PlannerAgent extends Agent {
  readonly name = "planner";
  readonly description = "Creates an execution plan for the requested change.";

  async run(): Promise<AgentResult> {
    if (!this.context.settings.openAiApiKey) {
      return {
        agent: this.name,
        status: AgentStatus.Failure,
        summary: "Missing OPENAI_API_KEY; planning skipped."
      };
    }

    try {
      const client = new LLMClient(this.context.settings);
      const myAIDEContent = this.getMyAIDEContent();
      const workspaceSummary = await this.getWorkspaceSummary();
      const codeScanSummary = this.getCodeScanSummary();
      const memorySummary = this.buildMemorySummary();
      const decisionSummary = this.getDecisionSummary();

      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            `USER REQUEST: ${this.context.request}`,
            myAIDEContent ? `\nPROJECT ARCHITECTURE (from myAIDE.md):\n${myAIDEContent}` : "",
            decisionSummary ? `\nINTENT ANALYSIS:\n${decisionSummary}` : "",
            workspaceSummary ? `\nWORKSPACE OVERVIEW:\n${workspaceSummary}` : "",
            codeScanSummary ? `\nRELEVANT FILES:\n${codeScanSummary}` : "",
            memorySummary ? `\nCONVERSATION HISTORY:\n${memorySummary}` : "",
            "\nGenerate a SPECIFIC todo list (4-6 concrete steps) for this request:"
          ]
            .filter(Boolean)
            .join("\n")
        }
      ];

      const completion = await client.complete(messages, {
        temperature: 0.2, // Lower temperature for more focused plans
        maxOutputTokens: 500 // Plans should be concise
      });

      const plan = this.parsePlan(completion.content);
      this.context.plan.splice(0, this.context.plan.length, ...plan);
      this.context.usage.prompt += completion.usagePromptTokens ?? 0;
      this.context.usage.completion += completion.usageCompletionTokens ?? 0;

      return {
        agent: this.name,
        status: AgentStatus.Success,
        summary: `Generated plan with ${plan.length} step(s).`,
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

  private parsePlan(raw: string): string[] {
    // Remove markdown code fences and extra formatting
    let cleaned = raw.trim();
    if (cleaned.startsWith("```")) {
      const match = cleaned.match(/^```(?:\w+)?\s*([\s\S]*?)```$/);
      if (match) {
        cleaned = match[1].trim();
      }
    }

    const lines = cleaned
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        // Extract numbered items (1. or 1) format)
        const match = line.match(/^\d+[.)]\s*(.*)$/);
        if (match) {
          return match[1].trim();
        }
        // Skip lines that look like headers or explanations
        if (line.startsWith("#") || line.startsWith("**") || line.length < 10) {
          return null;
        }
        return line;
      })
      .filter((line): line is string => line !== null && line.length > 0)
      .filter((line, index, arr) => arr.indexOf(line) === index); // Remove duplicates

    // Limit to 6 steps maximum
    const limited = lines.slice(0, 6);
    return limited.length ? limited : ["Complete the requested changes"];
  }

  private getMyAIDEContent(): string {
    const content = this.context.artifacts["myAIDEContent"] as string | undefined;
    if (content) {
      // Truncate if too long (keep under 2000 chars for planner)
      return content.length > 2000 ? content.slice(0, 2000) + "\n..." : content;
    }
    return "";
  }

  private getDecisionSummary(): string {
    const decision = this.context.artifacts["decision"] as
      | { intent?: string; rationale?: string; operations?: Array<{ action?: string; path?: string; reason?: string }> }
      | undefined;

    if (!decision) {
      return "";
    }

    const parts: string[] = [];
    if (decision.intent) {
      parts.push(`Intent: ${decision.intent}`);
    }
    if (decision.rationale) {
      parts.push(`Rationale: ${decision.rationale}`);
    }
    if (decision.operations && decision.operations.length > 0) {
      const ops = decision.operations
        .slice(0, 5)
        .map((op) => `- ${op.action} ${op.path || ""}${op.reason ? `: ${op.reason}` : ""}`)
        .join("\n");
      parts.push(`Operations:\n${ops}`);
    }

    return parts.join("\n");
  }

  private async getWorkspaceSummary(): Promise<string | undefined> {
    if (typeof this.context.artifacts.workspaceSummary === "string") {
      return this.context.artifacts.workspaceSummary as string;
    }
    try {
      const summary = await buildWorkspaceSummary(this.context.workspace);
      this.context.artifacts.workspaceSummary = summary;
      return summary;
    } catch {
      return undefined;
    }
  }

  private buildMemorySummary(): string {
    if (!this.context.memory.length) {
      return "";
    }
    return this.context.memory
      .slice(-4) // Reduced from 6 to save tokens
      .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`)
      .join("\n");
  }

  private getCodeScanSummary(): string {
    const scan = this.context.artifacts["codeScan"] as { summary?: string } | undefined;
    if (scan && typeof scan.summary === "string") {
      return scan.summary;
    }
    return "";
  }
}
