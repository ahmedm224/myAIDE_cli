# Architecture Overview

```
src/
├── agents/
│   ├── agent-base.ts       # Shared Agent, AgentContext, AgentResult contracts
│   ├── planner-agent.ts    # LLM-backed planning agent
│   ├── implementer-agent.ts# Generates file mutations and applies them
│   ├── analyzer-agent.ts   # Reviews diffs for potential risks
│   ├── validator-agent.ts  # Runs shell commands (tests, linters, etc.)
│   └── reporter-agent.ts   # Summarises the run for the user
├── config/settings.ts      # Environment-driven settings loader using Zod
├── context/workspace-summary.ts # Generates stack-aware summaries for planners/implementers
├── llm/openai-client.ts    # Minimal wrapper around the OpenAI Responses API
├── tools/filesystem.ts     # Workspace-scoped filesystem helper with dry-run support
├── tools/shell.ts          # Cross-platform shell execution helper
├── orchestrator.ts         # Coordinates context creation and agent sequencing
└── cli.ts                  # Commander-based CLI with interactive shell support
```

## Execution Flow

1. `cli.ts` loads `.env` data, ensures an `OPENAI_API_KEY` is present (prompting the user if needed), parses CLI flags, and constructs the orchestrator.
2. The CLI calls the AI decision engine to classify the requested change (create/modify/delete) using workspace summaries before implementation, showing the plan and seeking confirmation for destructive actions.
3. `orchestrator.ts` prepares the shared `AgentContext` with workspace tools, mutable memory, and token counters.
4. Agents execute sequentially, appending their `AgentResult` to the shared history and updating aggregated token usage. The implementer prefers anchor-based modifications; unified diffs are a fallback.
5. The reporter agent assembles a final summary which the CLI prints in a table plus optional detailed report, diffs, and usage metrics.
6. If validation fails, the CLI automatically rolls back the applied mutations using the captured before/after snapshots.

## Tooling Surface

- **FileSystemTool**: ensures all paths stay inside the designated workspace, honours dry-run mode, and surfaces per-mutation confirmation callbacks when the CLI is in prompt mode. Write operations capture before/after snapshots so diffs can be rendered and rolled back.
- **ShellTool**: executes commands with `shell: true`, enabling familiar command-line syntax on Windows PowerShell as well as Unix shells.

## LLM Usage

The planner, implementer, and analyzer agents reuse `LLMClient`, which wraps the OpenAI SDK’s Responses API. Prompts and JSON parsing logic remain local to each agent for easier customisation.

## Extensibility

- Supply a custom agent pipeline via `OrchestratorConfig.agents` (array of factories returning `Agent` instances).
- Introduce new artefacts or validation behaviours by storing structured data on `AgentContext.artifacts`.
- Swap models or tuning parameters by overriding `defaultModel` in the settings loader or CLI flags.
