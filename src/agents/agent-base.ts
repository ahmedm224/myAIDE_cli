import type { Settings } from "../config/settings";
import type { FileMutation } from "../tools/filesystem";
import type { FileSystemTool } from "../tools/filesystem";
import type { ShellTool } from "../tools/shell";

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export interface TokenUsage {
  prompt: number;
  completion: number;
}

export enum AgentStatus {
  Success = "success",
  Failure = "failure",
  Skipped = "skipped"
}

export interface AgentResult {
  agent: string;
  status: AgentStatus;
  summary: string;
  details?: string;
  mutations?: FileMutation[];
  completedPlanSteps?: number; // Number of plan steps this agent completed (for progress tracking)
}

export interface AgentContext {
  request: string;
  workspace: string;
  settings: Settings;
  plan: string[];
  artifacts: Record<string, unknown>;
  history: AgentResult[];
  filesystem?: FileSystemTool;
  shell?: ShellTool;
  memory: ConversationTurn[];
  usage: TokenUsage;
  registerResult: (result: AgentResult) => void;
}

export abstract class Agent {
  abstract readonly name: string;
  abstract readonly description: string;
  protected readonly context: AgentContext;

  constructor(context: AgentContext) {
    this.context = context;
  }

  abstract run(): Promise<AgentResult>;
}
