# myaide-cli

myaide-cli is a multi-agent AI coding assistant written in Node.js and TypeScript. It delivers a Codex/Claude-like CLI experience with workspace-scoped tools, colorised diffs, and an Ink-powered interface that keeps the entire software delivery loop inside your terminal.

## Feature Overview
- **Automatic Workspace Context (myAIDE.md)** – On first run, the tool analyzes your codebase and generates a comprehensive architecture document that grounds all subsequent AI operations. Subsequent runs read this file for instant, consistent context across all agents.
- **Multi-agent workflow** – Orchestrator coordinates Planner → Implementer → Analyzer → Validator → Reporter agents; each shares structured context and produces auditable output.
- **Intent-aware planning** – Pre-flight decision engine inspects the workspace, classifies the requested action (create/modify/delete), surfaces file targets, and produces concise TODO items before work begins.
- **Anchor-based editing** – Implementer performs context scanning, generates mutations anchored to the existing code, aggressively repairs LLM JSON (with automatic retry prompts), applies unified diffs when anchors are insufficient, and captures rollback snapshots.
- **Rich CLI experience** – Ink UI resets the terminal, shows a bordered multi-line input, renders the live TODO list with checkbox states, streams cooking-themed status messages, and keeps token usage + context percentage always visible.
- **Filesystem safety rails** – All file activity is sandboxed to the chosen workspace, honours `allow/prompt/dry-run` approval modes, shows colorised diffs (green additions, red removals only), and supports automatic rollback when validation fails.
- **Telemetry & memory** – Aggregated prompt/completion tokens, context utilisation, and agent commentary are displayed per turn. Session memory, slash commands, and user notes keep follow-up requests grounded.

## Architecture at a Glance
```
src/
├── agents/               # Role-specific agents plus shared contracts
├── cli.ts                # Entry point wiring Commander + Ink
├── context/
│   ├── code-scan.ts      # Token-based file relevance scoring
│   ├── workspace-summary.ts  # Language detection + file tree
│   └── myaide-manager.ts # NEW: myAIDE.md lifecycle management
├── decision/engine.ts    # AI-driven intent classification + approvals
├── llm/openai-client.ts  # OpenAI Responses API wrapper (gpt-4.1-mini default)
├── orchestrator.ts       # Coordinates myAIDE.md + agent pipeline + rollback
├── tools/                # Workspace filesystem + shell helpers
├── ui/App.tsx            # Ink React tree (plan panel, messages, footer)
└── index.ts              # Public exports for embedding
```

- **myAIDE.md System** – On first run, `MyAIDEManager` scans workspace and generates architecture doc via LLM. Subsequent runs read cached file. Content injected into `context.artifacts["myAIDEContent"]` for all agents.
- Agents stream structured `AgentResult` objects into a shared `AgentContext` that holds memory, plan state, artifact registry, and token usage totals.
- `context/code-scan.ts` builds stack-aware summaries (framework detection, key files) to ground plans and patches.
- `decision/engine.ts` powers the AI Code Decision Engine and integrates user approvals into the orchestrator flow.
- Post-build, `scripts/fix-imports.js` rewrites emitted import paths so Node's ESM loader resolves compiled modules correctly.

See `docs/myaide-feature.md` for myAIDE.md technical details, `docs/myaide-usage.md` for user guide, and `docs/architecture.md` for general deep dives.

## Requirements
- Node.js 18+ (Node 20+ recommended)
- OpenAI API key with access to `gpt-4.1-mini` (set `OPENAI_BASE_URL` for Azure/proxies)
- Workspace directory containing the project to modify

## Installation
```bash
npm install
npm run build
```

The build step compiles TypeScript (`tsc`) and then normalises emitted ESM imports. For local iteration run `npm run dev`, which uses `tsx` to execute `src/cli.ts` directly.

### Optional global command
```bash
npm link          # or: npm install -g .
myaide            # now available anywhere on your machine
```

## Configuration & Environment
myaide-cli loads configuration from (in order): process env vars, workspace `.env`, then CLI flags. Missing variables fall back to interactive prompts.

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Required. Prompted on launch if absent; can be stored in `.env`. |
| `OPENAI_BASE_URL` | Optional custom endpoint. |
| `MYAIDE_WORKSPACE` | Optional default workspace root. |
| `OPENAI_MODEL` | Override default model name (defaults to `gpt-4.1-mini`). |

When prompted for the API key, you can choose to persist it to the workspace `.env` for future runs.

## Running the CLI
### Interactive mode (recommended)
```powershell
npx myaide           # respects local install
# or, after linking:
myaide
```

Interactive mode launches the Ink UI:
- Terminal is cleared, welcome panel displayed near the bottom.
- Bordered multi-line input accepts Shift+Enter for newlines, Enter to submit.
- TODO list stays pinned above the input; agents tick items as completed.
- Message stream shows planner summaries, implementer commentary, analyzer notes, validator output, and reporter conclusions.
- Token counters (prompt, completion, context %) update in the footer each turn.

Use `/help` to discover slash commands for filesystem inspection, reading files, printing summaries, managing memory, or compacting the conversation.

### One-shot execution
```powershell
npx myaide "Add linting to the project"
```

This runs the full pipeline once, prints the plan, diffs, and report, then exits.

### Key CLI flags
- `-w, --workspace <path>` – Target a specific project directory.
- `--dry-run` – Preview mutations without writing to disk; diffs are still shown.
- `--validation-cmd <cmd...>` – Command executed during the validator stage (e.g. `--validation-cmd npm test`).
- `--verbose` – Emit verbose logging and raw agent payloads when troubleshooting.

## Workspace Permissions & Safety
- On launch you choose `allow all`, `prompt per change`, or `dry-run` for filesystem writes. Prompt mode previews the diff snippet before each edit.
- File mutations record before/after snapshots. If validation fails, the orchestrator automatically rolls back to the original content.
- Mutations render as colorised unified diffs showing only inserted (`green`) and removed (`red`) lines—unchanged context stays hidden to keep focus on the delta.
- Every change is attributed to the responsible agent with accompanying LLM commentary so you can audit reasoning.

## Agent Flow & Decision Engine
1. **Decision Engine** – Generates workspace summary, classifies intent (create, modify, delete, tooling), proposes affected files, and requests approval for destructive actions.
2. **Planner** – Crafts a concise TODO list tailored to the request and workspace scan (no boilerplate steps). Plans appear immediately in the UI for review.
3. **Implementer** – Generates JSON instructions containing anchor contexts and edits, repairs malformed JSON via `jsonrepair`, applies changes with fallback unified diffs, and describes each mutation.
4. **Analyzer** – Reviews diffs for risks (missing tests, regressions) and adds advisory notes to the transcript.
5. **Validator** – Runs configured shell commands inside the workspace and streams output.
6. **Reporter** – Produces the final report plus a quick recap of remaining TODOs or follow-up actions.

All agents share memory, prior turn transcripts, selected slash command outputs, and token budgets so multi-step tasks stay coherent. Conversation memory can be inspected with `/memory` or cleared with `/reset` mid-session.

## Development Workflow
- `npm run dev` – Run CLI from TypeScript sources with hot recompilation.
- `npm run build` – Compile to `dist/` and fix import extensions for Node ESM.
- `npm run clean` – Remove the `dist/` directory.

TypeScript configuration (`tsconfig.json`) targets `ESNext` modules with `moduleResolution: "bundler"` to align with the Ink + React typings. Generated JavaScript is native ESM; Node ≥18 supports this without flags.

## Troubleshooting
| Symptom | Fix |
| --- | --- |
| `OPENAI_API_KEY` prompt repeats | Store the key in `.env` or export it in your shell profile. |
| `npm run build` fails with missing typings | Re-run `npm install`; ensure `@types/react` and `@types/node` are present. |
| `SyntaxError: Unexpected identifier 'assert'` when running `myaide` | Ensure `npm run build` completed so `scripts/fix-imports.js` rewrote compiled imports; rebuild if `dist/` is stale. |
| Implementer reports “invalid JSON” | Retry the request— the implementer now auto-normalises Unicode, scans multiple `{}` blocks, and will prompt the LLM to re-emit strict JSON. If it still fails, the error message includes a snippet showing what to trim. |
| Implementer says “Failed to apply patch…” | The CLI now replays patches with several heuristics (fuzz factor, trimmed anchors, manual splice). When all attempts fail it prints actionable manual steps generated from the diff so you can apply the change safely. |
| Validator rollback did not trigger | Confirm the validation command returned a non-zero exit code; only failures trigger automatic restoration. |

## Additional Documentation
- `docs/architecture.md` – Architecture overview and execution flow.
- `docs/user-guide.md` – Expanded instructions, FAQs, and UI walkthroughs.

## License
MIT – see `LICENSE` or update `package.json` if distributing under a different license.
