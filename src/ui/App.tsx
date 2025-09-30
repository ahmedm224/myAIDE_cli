import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { Key } from "ink";
import { TextArea } from "./TextArea";
import {
  Orchestrator,
  type OrchestratorObservers,
  type OrchestratorRunResult,
} from "../orchestrator";
import { loadSettings, type Settings } from "../config/settings";
import {
  AgentStatus,
  type AgentResult,
  type ConversationTurn,
  type TokenUsage,
} from "../agents";
import { AICodeDecisionEngine } from "../decision/engine";
import { collectWorkspaceSnapshot, buildWorkspaceSummary } from "../context/workspace-summary";
import { collectRelevantCode } from "../context/code-scan";
import type { FileMutation, PendingMutation, MutationConfirm } from "../tools/filesystem";
import path from "node:path";
import { promises as fs } from "node:fs";

interface AppProps {
  initialRequest?: string;
}

type MessageKind = "system" | "plan" | "progress" | "event" | "tokens" | "result" | "error";

interface Message {
  id: string;
  kind: MessageKind;
  content: string;
}

interface PlanState {
  steps: string[];
  statuses: ("pending" | "done")[];
}

type MutationMode = "allow" | "prompt" | "dry-run";
type InteractionMode = "setup" | "api-key" | "permission" | "confirm" | "request";

interface State {
  input: string;
  working: boolean;
  messages: Message[];
  plan: PlanState | null;
  tokensPrompt: number;
  tokensCompletion: number;
}

type Action =
  | { type: "set-input"; value: string }
  | { type: "set-working"; value: boolean }
  | { type: "add-message"; message: Message }
  | { type: "set-plan"; steps: string[] }
  | { type: "complete-plan-step"; value?: number }
  | { type: "reset-plan" }
  | { type: "set-tokens"; prompt: number; completion: number };

const initialState: State = {
  input: "",
  working: false,
  messages: [],
  plan: null,
  tokensPrompt: 0,
  tokensCompletion: 0,
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "set-input":
      return { ...state, input: action.value };
    case "set-working":
      return { ...state, working: action.value };
    case "add-message":
      return { ...state, messages: [...state.messages, action.message] };
    case "set-plan":
      return {
        ...state,
        plan: {
          steps: action.steps,
          statuses: action.steps.map(() => "pending"),
        },
      };
    case "complete-plan-step": {
      if (!state.plan) return state;
      const count = action.value as number || 1;
      let completed = 0;
      const newStatuses = state.plan.statuses.map((status) => {
        if (status === "pending" && completed < count) {
          completed++;
          return "done";
        }
        return status;
      });
      return {
        ...state,
        plan: {
          steps: state.plan.steps,
          statuses: newStatuses,
        },
      };
    }
    case "reset-plan":
      return { ...state, plan: null };
    case "set-tokens":
      return { ...state, tokensPrompt: action.prompt, tokensCompletion: action.completion };
    default:
      return state;
  }
}

function makeMessage(kind: MessageKind, content: string): Message {
  return {
    id: `${kind}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    kind,
    content,
  };
}

function formatTokens(prompt: number, completion: number): string {
  const total = prompt + completion;
  const maxPrompt = 128_000;
  const pct = ((prompt / maxPrompt) * 100).toFixed(2);
  return `Prompt: ${prompt} (${pct}% of ${maxPrompt}) | Completion: ${completion} | Total: ${total}`;
}

function extractPlanSteps(raw: string): string[] {
  const steps = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^\d+[.)]\s*(.*)$/);
      return match ? match[1].trim() : line;
    });
  return Array.from(new Set(steps)).slice(0, 6);
}

const Welcome: React.FC = () => (
  <Box flexDirection="column" padding={1} borderStyle="round" borderColor="cyan">
    <Text color="cyan" bold>
      myaide CLI — Multi-Agent Code Assistant
    </Text>
    <Text>
      Describe your goal in the prompt box below. Press Shift+Enter for new lines, Enter to run, and Ctrl+C to exit.
    </Text>
  </Box>
);

const PlanView: React.FC<{ plan: PlanState }> = ({ plan }) => {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" padding={1} marginRight={1} width="33%">
      <Text color="magenta" bold>
        Plan
      </Text>
      {plan.steps.map((step: string, index: number) => {
        const status = plan.statuses[index];
        const checkbox = status === "done" ? "[✔]" : "[ ]";
        return (
          <Box key={index}>
            <Text color={status === "done" ? "green" : "yellow"}>
              {checkbox} {step}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
};

const MessageLine: React.FC<{ message: Message }> = ({ message }) => {
  const color: string =
    message.kind === "system"
      ? "cyan"
      : message.kind === "plan"
      ? "magenta"
      : message.kind === "progress"
      ? "green"
      : message.kind === "error"
      ? "red"
      : message.kind === "tokens"
      ? "blue"
      : "white";

  return <Text color={color}>{message.content}</Text>;
};

interface MessageListProps {
  messages: Message[];
  plan: PlanState | null;
}

const MessageList: React.FC<MessageListProps> = ({ messages, plan }) => (
  <Box flexDirection="row" flexGrow={1} paddingRight={1}>
    {plan ? <PlanView plan={plan} /> : null}
    <Box flexDirection="column" flexGrow={1}>
      {messages.map((message: Message) => (
        <MessageLine key={message.id} message={message} />
      ))}
    </Box>
  </Box>
);

const Footer: React.FC<{ tokensPrompt: number; tokensCompletion: number }> = ({ tokensPrompt, tokensCompletion }) => {
  const total = tokensPrompt + tokensCompletion;
  const maxPrompt = 128_000;
  const pct = ((tokensPrompt / maxPrompt) * 100).toFixed(1);

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} paddingY={0}>
      <Text color="white" bold>
        Tokens: <Text color="cyan">{tokensPrompt.toLocaleString()}</Text> prompt + <Text color="green">{tokensCompletion.toLocaleString()}</Text> completion = <Text color="yellow">{total.toLocaleString()}</Text> total | Context: <Text color="magenta">{pct}%</Text> of {maxPrompt.toLocaleString()}
      </Text>
    </Box>
  );
};

interface InputBoxProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  working: boolean;
  label: string;
  placeholder: string;
  disabled?: boolean;
  historyEnabled?: boolean;
  allowNewlines?: boolean;
}

const InputBox: React.FC<InputBoxProps> = ({
  value,
  onChange,
  onSubmit,
  working,
  label,
  placeholder,
  disabled = false,
  historyEnabled = true,
  allowNewlines = true,
}) => {
  const { exit } = useApp();
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const workingRef = useRef<boolean>(working);

  useInput((input: string, key: Key) => {
    if (key.escape) {
      exit();
    }
    if (!historyEnabled) {
      if (key.return && key.shift && allowNewlines) {
        onChange(`${value}\n`);
      }
      return;
    }

    // Disable history navigation when we have multi-line content
    const isMultiLine = value.includes('\n');

    if (key.upArrow && !isMultiLine) {
      setHistoryIndex((index: number | null) => {
        const lastIndex = history.length - 1;
        if (lastIndex < 0) return index;
        const nextIndex = index === null ? lastIndex : Math.max(0, index - 1);
        onChange(history[nextIndex] ?? "");
        return nextIndex;
      });
    }
    if (key.downArrow && !isMultiLine) {
      setHistoryIndex((index: number | null) => {
        if (index === null) {
          onChange("");
          return null;
        }
        const nextIndex = Math.min(history.length - 1, index + 1);
        if (nextIndex >= history.length) {
          onChange("");
          return null;
        }
        onChange(history[nextIndex] ?? "");
        return nextIndex;
      });
    }
    if (key.return && key.shift && allowNewlines) {
      onChange(`${value}\n`);
    }
  });

  const handleSubmit = () => {
    if (disabled) {
      return;
    }
    if (!value.trim() && !working) {
      return;
    }
    if (historyEnabled) {
      setHistory((prev: string[]) => [...prev, value]);
      setHistoryIndex(null);
    }
    onSubmit();
  };

  useEffect(() => {
    if (!historyEnabled) {
      return;
    }
    const wasWorking = workingRef.current;
    if (!wasWorking && working) {
      onChange("");
    }
    workingRef.current = working;
  }, [working, historyEnabled, onChange]);

  return (
    <TextArea
      value={value}
      onChange={onChange}
      onSubmit={handleSubmit}
      placeholder={placeholder}
      disabled={disabled || working}
      maxHeight={Math.min(12, Math.max(3, value.split(/\r?\n/).length))}
      label={label}
    />
  );
};

interface WorkflowOptions {
  settings: Settings;
  mutationMode: MutationMode;
  mutationConfirm?: MutationConfirm;
}

export const App: React.FC<AppProps> = ({ initialRequest }) => {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef<State>(state);
  const memoryRef = useRef<ConversationTurn[]>([]);
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  const [mode, setMode] = useState<InteractionMode>("setup");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [mutationMode, setMutationMode] = useState<MutationMode>("allow");
  const [pendingMutation, setPendingMutation] = useState<PendingMutation | null>(null);
  const confirmResolverRef = useRef<((value: boolean) => void) | null>(null);

  // Global escape key handler
  useInput((input, key) => {
    if (key.escape) {
      exit();
    }
  });

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const appendMessage = useCallback((message: Message) => {
    dispatch({ type: "add-message", message });
  }, []);

  const handleInputChange = useCallback(
    (value: string) => {
      dispatch({ type: "set-input", value: value.replace(/\r\n?/g, "\n") });
    },
    [dispatch]
  );

  useEffect(() => {
    try {
      const loaded = loadSettings();
      setSettings(loaded);
      appendMessage(
        makeMessage(
          "system",
          `Workspace: ${loaded.runtime.workspaceRoot}`
        )
      );
      if (!loaded.openAiApiKey) {
        appendMessage(makeMessage("system", "OPENAI_API_KEY not found. Paste your key to continue."));
        setMode("api-key");
      } else {
        appendMessage(
          makeMessage(
            "system",
            "Select workspace change mode: 1) Allow all, 2) Prompt each change, 3) Dry-run"
          )
        );
        setMode("permission");
      }
    } catch (error) {
      appendMessage(makeMessage("error", `Failed to load settings: ${(error as Error).message}`));
      setMode("api-key");
    }
  }, [appendMessage]);

  useEffect(() => {
    if (initialRequest && !welcomeDismissed && mode === "request") {
      dispatch({ type: "set-input", value: initialRequest });
    }
  }, [initialRequest, welcomeDismissed, mode]);

  const requestMutationApproval = useCallback(
    async (mutation: PendingMutation): Promise<boolean> => {
      setPendingMutation(mutation);
      setMode("confirm");
      dispatch({ type: "set-input", value: "" });
      dispatch({ type: "set-working", value: false });
      const action = mutation.action.toUpperCase();
      appendMessage(makeMessage("system", `Pending ${action} -> ${mutation.path}`));
      if (mutation.preview) {
        appendMessage(makeMessage("system", truncatePreview(mutation.preview)));
      }
      appendMessage(makeMessage("system", "Approve change? (y/N)"));

      return await new Promise<boolean>((resolve) => {
        confirmResolverRef.current = (decision: boolean) => {
          dispatch({ type: "set-working", value: true });
          resolve(decision);
        };
      });
    },
    [appendMessage]
  );

  const handleApiKeySubmit = useCallback(
    async (raw: string) => {
      const key = raw.trim();
      if (!key) {
        appendMessage(makeMessage("error", "Please paste a valid OpenAI API key."));
        return;
      }
      const workspaceRoot = settings?.runtime.workspaceRoot ?? process.cwd();
      try {
        process.env.OPENAI_API_KEY = key;
        await persistApiKey(workspaceRoot, key);
        appendMessage(makeMessage("system", `Stored OPENAI_API_KEY in ${path.join(workspaceRoot, ".env")}`));
        const refreshed = loadSettings();
        setSettings(refreshed);
        appendMessage(
          makeMessage(
            "system",
            "Select workspace change mode: 1) Allow all, 2) Prompt each change, 3) Dry-run"
          )
        );
        setMode("permission");
      } catch (error) {
        appendMessage(makeMessage("error", `Failed to persist API key: ${(error as Error).message}`));
      }
    },
    [appendMessage, settings]
  );

  const handlePermissionSelection = useCallback(
    (raw: string) => {
      const choice = raw.trim().toLowerCase();
      let selected: MutationMode | null = null;
      if (["1", "allow", "allow all", "yes", "y"].includes(choice)) {
        selected = "allow";
      } else if (["2", "prompt", "p"].includes(choice)) {
        selected = "prompt";
      } else if (["3", "dry", "dry-run", "dryrun", "d"].includes(choice)) {
        selected = "dry-run";
      }
      if (!selected) {
        appendMessage(makeMessage("error", "Enter 1 (allow), 2 (prompt), or 3 (dry-run)."));
        return;
      }
      setMutationMode(selected);
      appendMessage(makeMessage("system", `Workspace change mode set to ${selected}.`));
      setMode("request");
    },
    [appendMessage]
  );

  const handleConfirmationResponse = useCallback(
    (raw: string) => {
      if (!confirmResolverRef.current) {
        return;
      }
      const choice = raw.trim().toLowerCase();
      const accepted = ["y", "yes", "allow", "approve"].includes(choice);
      const rejected = ["n", "no", "deny", "reject"].includes(choice);
      if (!accepted && !rejected) {
        appendMessage(makeMessage("error", "Please respond with 'y' or 'n'."));
        return;
      }
      const resolver = confirmResolverRef.current;
      confirmResolverRef.current = null;
      setPendingMutation(null);
      setMode("request");
      dispatch({ type: "set-input", value: "" });
      appendMessage(makeMessage("system", accepted ? "Change approved." : "Change declined."));
      resolver(accepted);
    },
    [appendMessage]
  );

  const handleSubmit = async () => {
    const input = stateRef.current.input.trim();
    if (!input) {
      return;
    }

    if (mode === "api-key") {
      await handleApiKeySubmit(input);
      dispatch({ type: "set-input", value: "" });
      return;
    }

    if (mode === "permission") {
      handlePermissionSelection(input);
      dispatch({ type: "set-input", value: "" });
      return;
    }

    if (mode === "confirm") {
      handleConfirmationResponse(input);
      dispatch({ type: "set-input", value: "" });
      return;
    }

    if (mode !== "request") {
      return;
    }

    if (stateRef.current.working) {
      return;
    }

    if (!settings) {
      appendMessage(makeMessage("error", "Settings not initialised yet."));
      return;
    }

    const freshSettings = loadSettings();
    setSettings(freshSettings);
    if (!freshSettings.openAiApiKey) {
      appendMessage(makeMessage("error", "OPENAI_API_KEY is required to use the assistant."));
      setMode("api-key");
      return;
    }

    setWelcomeDismissed(true);
    dispatch({ type: "set-working", value: true });
    dispatch({ type: "reset-plan" });
    appendMessage(makeMessage("event", `> ${input}`));
    memoryRef.current.push({ role: "user", content: input });

    try {
      const confirmFn = mutationMode === "prompt" ? requestMutationApproval : undefined;
      const outcome = await runWorkflow(input, dispatch, appendMessage, memoryRef.current, {
        settings: freshSettings,
        mutationMode,
        mutationConfirm: confirmFn,
      });
      if (outcome) {
        const reporter = outcome.results.find((res) => res.agent === "reporter");
        if (reporter?.details) {
          memoryRef.current.push({ role: "assistant", content: reporter.details });
        }
      }
    } catch (error) {
      appendMessage(makeMessage("error", (error as Error).message));
    } finally {
      dispatch({ type: "set-working", value: false });
      dispatch({ type: "set-input", value: "" });
      setMode("request");
    }
  };

  const inputLabel =
    mode === "api-key"
      ? "OpenAI API Key"
      : mode === "permission"
      ? "Workspace Permissions"
      : mode === "confirm"
      ? "Approve Change"
      : "Prompt";
  const inputPlaceholder =
    mode === "api-key"
      ? "Paste your OpenAI API key"
      : mode === "permission"
      ? "Type 1=Allow, 2=Prompt, 3=Dry-run"
      : mode === "confirm"
      ? "Approve with y / n"
      : state.working
      ? "Running..."
      : "Describe your goal";

  return (
    <Box flexDirection="column" height={process.stdout.rows ?? 40} padding={1}>
      {/* Welcome banner - dismissable */}
      {!welcomeDismissed && <Welcome />}

      {/* Scrollable message area - takes remaining space */}
      <Box flexDirection="column" flexGrow={1} marginTop={welcomeDismissed ? 1 : 2} overflow="hidden">
        <MessageList messages={state.messages} plan={state.plan} />
      </Box>

      {/* Fixed bottom section - input + footer (doesn't scroll) */}
      <Box flexDirection="column" flexShrink={0} paddingTop={1} gap={1}>
        {/* Pending mutation preview (if any) */}
        {pendingMutation ? (
          <Box flexDirection="column" borderStyle="round" borderColor="yellow" padding={1}>
            <Text color="yellow" bold>
              Pending {pendingMutation.action.toUpperCase()} – {pendingMutation.path}
            </Text>
            {pendingMutation.preview ? <Text>{truncatePreview(pendingMutation.preview)}</Text> : null}
          </Box>
        ) : null}

        {/* Input box - always visible at bottom */}
        <InputBox
          value={state.input}
          onChange={handleInputChange}
          onSubmit={handleSubmit}
          working={state.working}
          label={inputLabel}
          placeholder={inputPlaceholder}
          disabled={mode === "setup"}
          historyEnabled={mode === "request"}
          allowNewlines={mode === "request"}
        />

        {/* Footer with tokens - at very bottom */}
        <Footer tokensPrompt={state.tokensPrompt} tokensCompletion={state.tokensCompletion} />
      </Box>
    </Box>
  );
};

async function runWorkflow(
  request: string,
  dispatch: React.Dispatch<Action>,
  append: (message: Message) => void,
  memory: ConversationTurn[],
  options: WorkflowOptions
): Promise<OrchestratorRunResult | null> {
  const { settings, mutationMode, mutationConfirm } = options;
  if (!settings.openAiApiKey) {
    throw new Error("OPENAI_API_KEY is required to use the assistant");
  }

  const effectiveSettings: Settings = {
    ...settings,
    runtime: {
      ...settings.runtime,
      dryRun: mutationMode === "dry-run",
    },
  };

  const workspaceRoot = effectiveSettings.runtime.workspaceRoot ?? process.cwd();

  append(makeMessage("system", "Gathering workspace context..."));

  const [workspaceSummary, snapshot, codeScan] = await Promise.all([
    buildWorkspaceSummary(workspaceRoot),
    collectWorkspaceSnapshot(workspaceRoot, 2),
    collectRelevantCode(request, workspaceRoot, 5),
  ]);

  const decisionEngine = new AICodeDecisionEngine(effectiveSettings);
  const decision = await decisionEngine.decide({
    request,
    workspaceSummary,
    snapshot,
    memory,
  });

  append(
    makeMessage(
      "system",
      `Decision: ${decision.outcome.intent.toUpperCase()} (confidence ${(decision.outcome.confidence * 100).toFixed(0)}%)`
    )
  );
  if (decision.outcome.operations.length) {
    append(
      makeMessage(
        "system",
        decision.outcome.operations
          .map(
            (op) => `${op.action.toUpperCase()} ${op.path ?? "(unspecified)"}${op.reason ? ` — ${op.reason}` : ""}`
          )
          .join("\n")
      )
    );
  }

  const orchestrator = new Orchestrator(effectiveSettings, {
    mutationConfirm,
    iterativeRefinement: {
      enabled: true,
      maxIterations: 2,
      requireValidation: true,
      requireNoCriticalIssues: true,
    },
  });
  const observers: OrchestratorObservers = {
    onAgentStart: (agentName) => {
      append(makeMessage("system", `Start ${agentName}`));
    },
    onAgentFinish: (result) => {
      const mark =
        result.status === AgentStatus.Success
          ? "✔"
          : result.status === AgentStatus.Failure
          ? "✖"
          : "➖";
      append(makeMessage("progress", `${mark} ${result.agent}: ${result.summary}`));

      // Show details for planner
      if (result.agent === "planner" && result.status === AgentStatus.Success && result.details) {
        const steps = extractPlanSteps(result.details);
        if (steps.length) {
          dispatch({ type: "set-plan", steps });
          append(
            makeMessage(
              "plan",
              steps.map((step, idx) => `${idx + 1}. ${step}`).join("\n")
            )
          );
        }
      }
      // Show details for analyzer, optimizer, test-generator
      else if (result.details && (result.agent === "analyzer" || result.agent === "optimizer" || result.agent === "test-generator")) {
        append(makeMessage("system", `\n=== ${result.agent.toUpperCase()} DETAILS ===\n${result.details}`));
      }

      // Update plan progress
      if (result.status === AgentStatus.Success && result.agent !== "planner" && result.agent !== "reporter") {
        const stepsCompleted = result.completedPlanSteps ?? 1;
        dispatch({ type: "complete-plan-step", value: stepsCompleted });
      }
    },
  };

  const outcome = await orchestrator.run(request, observers, memory, {
    workspaceSummary,
    codeScan,
    decision: decision.outcome,
  });

  const combinedUsage = combineUsage(decision.usage, outcome.usage);
  dispatch({ type: "set-tokens", prompt: combinedUsage.prompt, completion: combinedUsage.completion });

  const reporter = outcome.results.find((res) => res.agent === "reporter");
  if (reporter?.details) {
    append(makeMessage("result", reporter.details));
  }

  const dryRun = effectiveSettings.runtime.dryRun ?? false;
  if (!dryRun) {
    const failure = outcome.results.find(
      (res) => res.agent === "validator" && res.status === AgentStatus.Failure
    );
    if (failure) {
      append(makeMessage("system", "Validator failed — rolling back changes..."));
      const appliedMutations = outcome.results
        .flatMap((res) => res.mutations ?? [])
        .filter((mutation) => mutation.applied);
      if (appliedMutations.length) {
        await rollbackMutations(workspaceRoot, appliedMutations);
        append(makeMessage("system", "Rollback complete."));
      }
    }
  }

  return outcome;
}

function combineUsage(...usages: Array<TokenUsage | undefined>): TokenUsage {
  return usages.reduce<TokenUsage>(
    (acc, usage) => {
      if (!usage) return acc;
      return {
        prompt: acc.prompt + (usage.prompt ?? 0),
        completion: acc.completion + (usage.completion ?? 0),
      };
    },
    { prompt: 0, completion: 0 }
  );
}

async function rollbackMutations(workspaceRoot: string, mutations: FileMutation[]): Promise<void> {
  const latestByPath = new Map<string, FileMutation>();
  for (const mutation of mutations) {
    latestByPath.set(mutation.path, mutation);
  }
  const ordered = Array.from(latestByPath.values()).reverse();
  for (const mutation of ordered) {
    const target = path.resolve(workspaceRoot, mutation.path);
    try {
      if (mutation.action === "write") {
        if (typeof mutation.before === "string") {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, mutation.before, "utf8");
        } else {
          await fs.rm(target, { force: true });
        }
      } else if (mutation.action === "delete") {
        if (typeof mutation.before === "string") {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, mutation.before, "utf8");
        }
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`Failed to rollback ${mutation.path}: ${(error as Error).message}`);
    }
  }
}

async function persistApiKey(workspaceRoot: string, apiKey: string): Promise<void> {
  const envPath = path.join(workspaceRoot, ".env");
  let existing = "";
  try {
    existing = await fs.readFile(envPath, "utf8");
  } catch {
    existing = "";
  }
  let next = existing;
  if (next.includes("OPENAI_API_KEY=")) {
    next = next.replace(/^OPENAI_API_KEY=.*$/m, `OPENAI_API_KEY=${apiKey}`);
  } else {
    if (next.length && !next.endsWith("\n")) {
      next += "\n";
    }
    next += `OPENAI_API_KEY=${apiKey}\n`;
  }
  await fs.writeFile(envPath, next, "utf8");
}

function truncatePreview(preview: string): string {
  const lines = preview.replace(/\r\n/g, "\n").split("\n");
  if (lines.length <= 12) {
    return preview;
  }
  return `${lines.slice(0, 12).join("\n")}\n... (${lines.length - 12} more lines)`;
}
