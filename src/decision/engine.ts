import { LLMClient, type ChatMessage } from "../llm/openai-client";
import type { Settings } from "../config/settings";
import type { WorkspaceSnapshot } from "../context/workspace-summary";
import type { ConversationTurn, TokenUsage } from "../agents";
import { jsonrepair } from "jsonrepair";

const SYSTEM_PROMPT = `You are the AI code decision engine for a multi-agent CLI assistant.
Given a user request and a workspace snapshot, classify the required file operations BEFORE any implementation happens.
- Prefer MODIFY when existing files in the relevant language already exist.
- Use CREATE for brand new components in empty or missing files.
- Use DELETE sparingly, only if the request clearly instructs removal.
- If unsure, choose MODIFY but explain the uncertainty.
Respond strictly in JSON using the schema:
{
  "intent": "create" | "modify" | "delete" | "mixed",
  "confidence": 0-1 number,
  "rationale": "short explanation",
  "operations": [
    { "action": "create" | "modify" | "delete", "path": "optional/path", "reason": "why" }
  ]
}`;

export type DecisionIntent = "create" | "modify" | "delete" | "mixed";

export interface DecisionOperation {
  action: "create" | "modify" | "delete";
  path?: string;
  reason?: string;
}

export interface DecisionOutcome {
  intent: DecisionIntent;
  confidence: number;
  rationale: string;
  operations: DecisionOperation[];
}

export interface DecisionResult {
  outcome: DecisionOutcome;
  usage: TokenUsage;
}

interface DecideOptions {
  request: string;
  workspaceSummary: string;
  snapshot: WorkspaceSnapshot;
  memory: ConversationTurn[];
}

export class AICodeDecisionEngine {
  private readonly client: LLMClient;

  constructor(settings: Settings) {
    this.client = new LLMClient(settings);
  }

  async decide(options: DecideOptions): Promise<DecisionResult> {
    const { request, workspaceSummary, snapshot, memory } = options;

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          `User request: ${request}`,
          `Workspace summary:\n${workspaceSummary}`,
          snapshot.files.length
            ? `Known files (${Math.min(snapshot.files.length, 50)} shown):\n${snapshot.files.slice(0, 50).join("\n")}`
            : "No files present in workspace.",
          memory.length
            ? `Recent conversation:\n${memory
                .slice(-4)
                .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`)
                .join("\n")}`
            : ""
        ]
          .filter(Boolean)
          .join("\n\n")
      }
    ];

    const completion = await this.client.complete(messages, {
      maxOutputTokens: 400,
      temperature: 0
    });

    const sanitized = this.sanitizeJson(completion.content);
    const parsed = this.parseWithRepair(sanitized, completion.content);
    const outcome = this.parseOutcome(parsed);

    return {
      outcome,
      usage: {
        prompt: completion.usagePromptTokens ?? 0,
        completion: completion.usageCompletionTokens ?? 0
      }
    };
  }

  private sanitizeJson(raw: string): string {
    let trimmed = raw.trim();
    if (trimmed.startsWith("```")) {
      const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
      if (match) {
        trimmed = match[1];
      }
    }
    if (!trimmed.startsWith("{")) {
      const first = trimmed.indexOf("{");
      const last = trimmed.lastIndexOf("}");
      if (first !== -1 && last !== -1 && last >= first) {
        trimmed = trimmed.slice(first, last + 1);
      }
    }
    return trimmed;
  }

  private parseWithRepair(candidate: string, raw: string): any {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      try {
        const repaired = jsonrepair(candidate);
        return JSON.parse(repaired);
      } catch (repairError) {
        throw new Error(
          `Decision engine returned invalid JSON: ${(repairError as Error).message} (original ${(error as Error).message})\nRaw: ${raw}`
        );
      }
    }
  }

  private parseOutcome(data: any): DecisionOutcome {
    const intent = this.parseIntent(data?.intent);
    const confidence = typeof data?.confidence === "number" ? data.confidence : 0.5;
    const rationale = typeof data?.rationale === "string" ? data.rationale : "No rationale provided.";
    const operations = Array.isArray(data?.operations)
      ? data.operations
          .map((op: any) => this.parseOperation(op))
          .filter((op: DecisionOperation | null): op is DecisionOperation => op !== null)
      : [];

    return {
      intent,
      confidence: Math.max(0, Math.min(1, confidence)),
      rationale,
      operations
    };
  }

  private parseIntent(value: unknown): DecisionIntent {
    if (value === "create" || value === "modify" || value === "delete" || value === "mixed") {
      return value;
    }
    return "modify";
  }

  private parseOperation(raw: any): DecisionOperation | null {
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const action = raw.action;
    if (action !== "create" && action !== "modify" && action !== "delete") {
      return null;
    }
    const op: DecisionOperation = { action };
    if (typeof raw.path === "string") {
      op.path = raw.path;
    }
    if (typeof raw.reason === "string") {
      op.reason = raw.reason;
    }
    return op;
  }
}
