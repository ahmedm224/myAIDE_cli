# myaide-cli Documentation

## 1. Overview
myaide-cli is a multi-agent coding assistant for the terminal. It orchestrates dedicated Planner, Implementer, Analyzer, Validator, and Reporter agents to cover the entire development loop. The tool is designed for Windows PowerShell as well as macOS and Linux shells, supports workspace-scoped file editing with permission controls, and communicates with OpenAI's `gpt-4.1-mini` model for cost-effective reasoning.

## 2. Requirements
- Node.js 18 or newer (Node 20+ recommended for the bundled npm version)
- An OpenAI API key with access to `gpt-4.1-mini`
- A project workspace directory containing the code you want to modify

Optional but recommended:
- `npm link` (or `npm install -g .`) to expose the `myaide` command globally

## 3. Installation
Run the installation command inside the repository root:

```bash
npm install
npm run build
```

The `build` script compiles TypeScript and emits executables under `dist/`. For iterative development you can use `npm run dev`, which leverages `tsx` to run directly from the TypeScript sources.

## 4. Authentication & Configuration
myaide-cli reads configuration from environment variables and `.env` files. On startup the tool loads environment variables from:

1. The current shell session
2. The project workspace `.env` file (if present)

### 4.1 Required Environment Variables
- `OPENAI_API_KEY`: OpenAI API key. If this value is missing at launch, myaide-cli prompts the user to enter it and offers to store the key in the workspace `.env` file for future runs.

### 4.2 Optional Environment Variables
- `OPENAI_BASE_URL`: Overrides the default OpenAI endpoint, useful for proxies or Azure/OpenAI-compatible stacks
- `MYAIDE_WORKSPACE`: Sets a default workspace directory; can be overridden per run with the `--workspace` flag

### 4.3 Example `.env`
```
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
```

## 5. Launching the CLI

### 5.1 Interactive Shell (Recommended)
```
npx myaide
# or, after linking the package globally:
myaide
```

The interactive mode drops you into a REPL-style session with persistent memory. Each task is executed when you press Enter. Type `exit`, `quit`, or `q` to leave the session. Conversation memory (user prompts + assistant summaries) is preserved for the duration of the process so the agents can follow up and fix issues.

### 5.2 One-Shot Run
```
npx myaide "Add linting to the project"
```

This mode runs the full agent workflow once with the given request and exits immediately.

### 5.3 Common CLI Options
- `-w, --workspace <path>`: Run against a specific workspace directory (defaults to the current working directory)
- `--dry-run`: Prevent file writes; mutations are simulated and reported only
- `--validation-cmd <cmd...>`: Command executed by the Validator agent (e.g. `--validation-cmd npm test`)
- `--verbose`: Adds stack traces to error output

### 5.4 Slash Commands
Inside interactive mode, commands prefixed with `/` act as local tools:

- `/help` – display the command list
- `/ls [path]` – list workspace contents
- `/read <path>` – preview up to 200 lines of a file
- `/context` – print a workspace summary + dominant stack
- `/note <text>` – add a compact note to the current memory (keeps conversation focused)
- `/memory` / `/reset` – inspect or clear the stored memory

Slash commands help you compact the conversation by pulling context on demand without forwarding it to the LLM.

## 6. Workspace Permission Flow
At startup myaide-cli asks how to handle filesystem changes for the selected workspace:

1. **Allow all** – Agents may mutate files without further prompts
2. **Prompt per change** – Each write/delete is previewed and requires explicit approval
3. **Dry-run** – No file changes are applied; actions are reported only

Approval decisions are cached per workspace for the duration of the process. When prompt mode is active, the CLI previews the first few lines of the proposed change before asking for confirmation.

## 7. Agent Pipeline
1. **Planner** – Breaks the user request into a numbered plan, grounded in an auto-generated workspace summary and recent conversation turns.
2. **Implementer** – Requests JSON-formatted file mutations from the LLM, using the same workspace summary + memory, and applies anchored modifications or diffs via the filesystem tool (anchors pinpoint insert/replace locations so unrelated code remains intact; unified diffs are a fallback).
3. **Analyzer** – Reviews changed files for risks, missing tests, or edge cases.
4. **Validator** – Executes an optional shell command (tests, lint, etc.) to confirm changes.
5. **Reporter** – Aggregates findings into a final summary for the user.

Agents share context through an in-memory state containing the original request, generated plan, applied mutations, validation hints, conversation memory, and prior agent results. Aggregate token usage is tracked so the CLI can report consumption per run.

An intent classification stage precedes the pipeline. The AI decision engine analyzes the request + workspace snapshot to decide whether to create, modify, or delete files, surfaces its rationale, and prompts for confirmation before destructive changes.

After the validator runs, any failures automatically trigger a rollback of applied mutations, restoring previous file contents to keep the workspace clean.

## 8. Console Output & Styling
- Cooking-themed status messages indicate agent progress (e.g., “🍅 Mise en place” for the Planner).
- Colored tables summarize each agent’s status (`green` success, `red` failure, `gray` skipped).
- Mutation summaries use consistent icons: `🟢` for writes, `🔴` for deletions, and `⏸️` for skipped actions (dry-run or declined). Colorized diffs show the actual code inserted or removed.
- The “Recipe Plan” section prints the numbered plan in magenta for quick scanning.
- A “Token Usage” panel reports prompt/completion totals and percentage of the max context consumed.

## 9. Tools & Integration
### 9.1 FileSystemTool
- Enforces workspace boundaries to prevent escaping the designated directory.
- Supports dry-run mode and mutation confirmation callbacks.
- Provides read, write, delete, list, and directory creation helpers.
- Captures file snapshots (before/after) to enable rollback when validation fails.

### 9.2 ShellTool
- Executes commands inside the workspace directory.
- Uses `shell: true` for Windows PowerShell compatibility.
- Returns stdout/stderr and throws if the exit code is non-zero.

## 10. Customization
- **Agents**: Extend `Agent` and register custom factories via `OrchestratorConfig.agents`.
- **Model parameters**: Override defaults via `SettingsOverrides` or environment variables (`temperature`, `maxOutputTokens`).
- **Prompts**: Modify system/user prompts inside `src/agents/*.ts` for domain-specific behavior.
- **Validation**: Pass custom commands to the Validator or store hints in `AgentContext.artifacts.validation_hint` during earlier stages.

## 11. Troubleshooting
| Issue | Resolution |
| --- | --- |
| `OPENAI_API_KEY` prompt appears every run | Store the key in `.env` or set it as a persistent environment variable. |
| CLI exits with “Missing OPENAI_API_KEY” | Ensure the key is correctly set and there are no trailing spaces. |
| No files are created | Confirm you chose “Allow all” or “Prompt per change” at the permission prompt and approve mutations as they appear. |
| `npm run build` fails with missing modules | Re-run `npm install` to ensure all dependencies (notably `dotenv`, `diff`) are installed. |
| Validation commands fail | Verify the command exists in the workspace and returns exit code `0` on success. |

## 12. FAQ
- **Does the CLI support global installation?** Yes. Run `npm link` or `npm install -g .` to make `myaide` available everywhere.
- **Can the assistant operate offline?** No. It requires the OpenAI API for reasoning.
- **How do I change the workspace mid-session?** Exit the CLI and relaunch with `--workspace <path>` or change directories before starting.
- **Can I integrate a different model?** Yes. Set `OPENAI_BASE_URL` and adjust `defaultModel.model` via environment variables, provided the target endpoint implements the OpenAI Responses API.

## 13. Directory Reference
```
src/
├── agents/            # Agent base types and implementations
├── config/            # Settings loader and schema definitions
├── llm/               # OpenAI Responses API wrapper
├── tools/             # Filesystem and shell utilities
├── orchestrator.ts    # Agent orchestration and context wiring
├── cli.ts             # Commander CLI with interactive workflow & approvals
└── index.ts           # Re-export entry point for embedding
```

docs/
├── architecture.md    # High-level architecture overview
└── user-guide.md      # This document

## 14. License
The project is distributed under the MIT License. Adjust in `package.json` if your distribution needs differ.

---
For additional questions or feature requests, open an issue in the repository or contact the maintainer listed in `package.json`.
