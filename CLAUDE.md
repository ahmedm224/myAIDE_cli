# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

myaide-cli is a multi-agent AI coding assistant CLI built with Node.js and TypeScript. It orchestrates specialized agents (Planner, Implementer, Analyzer, Validator, Reporter) to automate software development tasks through a terminal interface powered by Ink (React for CLI).

**Key Feature**: Automatic **myAIDE.md** workspace context file generation and management - the tool analyzes your codebase on first run to create a comprehensive architecture document that grounds all subsequent AI operations.

## Development Commands

### Build & Run
```bash
npm run build        # Compile TypeScript to dist/ and fix ESM imports
npm run dev          # Run from source with tsx (hot reload)
npm run clean        # Remove dist/ directory
npm run prepare      # Pre-publish build hook
```

### Testing & Execution
```bash
# Run the CLI locally
npx myaide
npm run dev

# One-shot mode
npx myaide "Add linting to the project"

# With options
npx myaide -w /path/to/workspace --dry-run --verbose
```

## Key Architecture Patterns

### myAIDE.md Workspace Context System (NEW)
**Location**: `src/context/myaide-manager.ts`

Automated workspace documentation system with 3 scenarios:

1. **First Run (No myAIDE.md)**:
   - Orchestrator detects missing myAIDE.md
   - MyAIDEManager scans workspace (depth=3, analyzes package.json, README, etc.)
   - LLM generates comprehensive architecture document
   - File written to workspace root
   - Content injected into `context.artifacts["myAIDEContent"]`

2. **Subsequent Runs (myAIDE.md exists)**:
   - Orchestrator reads existing myAIDE.md
   - Checks if key files (package.json, tsconfig.json, etc.) are newer
   - If stale, suggests regeneration (non-blocking)
   - Content loaded into all agents via artifacts

3. **Change Detection**:
   - Compares myAIDE.md mtime vs key configuration files
   - Warns user if architecture likely outdated
   - Future: `/refresh-myaide` command to regenerate

**Agent Integration**: All agents now receive myAIDE.md via `context.artifacts["myAIDEContent"]`. Implementer agent prioritizes this over workspace-summary when both present (src/agents/implementer-agent.ts:235-240).

### Multi-Agent Pipeline (Optimized with Parallel Execution)
The core flow is orchestrated through `src/orchestrator.ts` with **5 phases**:

**PHASE 1: Planning** (Sequential)
1. **Decision Engine** (`src/decision/engine.ts`) - AI-powered intent classification, file detection, approval requests
2. **Planner Agent** - Generates CONCRETE, SPECIFIC TODO list (4-6 steps) from request + myAIDE.md + workspace context

**PHASE 2: Implementation** (Sequential)
3. **Implementer Agent** - Applies code mutations using anchor-based editing with JSON repair fallbacks; reports `completedPlanSteps` based on files modified

**PHASE 3: Analysis & Quality** (**PARALLEL EXECUTION** ⚡)
4. **Analyzer Agent** - Reviews diffs for risks and missing tests
5. **TestGenerator Agent** (NEW) - Automatically generates test files following project conventions
6. **Optimizer Agent** (NEW) - Identifies performance bottlenecks, memory leaks, optimization opportunities

**PHASE 4: Validation** (Sequential)
7. **Validator Agent** - Runs shell commands (e.g., `npm test`)

**PHASE 5: Reporting** (Sequential)
8. **Reporter Agent** - Produces final summary and follow-up suggestions

All agents inherit from `Agent` base class (src/agents/agent-base.ts) and share a common `AgentContext` containing:
- `request`, `workspace`, `settings`
- `plan` (TODO list), `artifacts` (shared state including myAIDEContent), `history` (prior results)
- `filesystem` (FileSystemTool), `shell` (ShellTool)
- `memory` (conversation turns), `usage` (token tracking)

**Planner Improvements (src/agents/planner-agent.ts:6-30)**:
- Emphasizes CONCRETE steps over generic tasks ("Add login() to src/auth.ts" NOT "Implement auth")
- Integrates myAIDE.md for architecture-aware planning
- Includes decision engine intent analysis
- Lower temperature (0.2) for focused plans
- Max 6 steps, action-verb oriented

### Context Building
- **Code Scanning** (`src/context/code-scan.ts`) - Token-based relevance scoring to find files matching the request; limits depth to 5, max 500 files, 200KB per file
- **Workspace Summary** (`src/context/workspace-summary.ts`) - Detects frameworks, lists key files, builds prompt context

### Filesystem Safety
- **Sandboxing** - `FileSystemTool` (src/tools/filesystem.ts) validates all paths stay within workspace root
- **Mutation Modes** - `allow` (auto-apply), `prompt` (preview diffs), `dry-run` (no writes)
- **Rollback** - Captures `before`/`after` content; orchestrator restores on validation failure
- **Diff Rendering** - Unified diffs show only insertions (green) and deletions (red), no unchanged context

### ESM Import Fix
TypeScript emits ESM without `.js` extensions. After `tsc`, `scripts/fix-imports.js` walks `dist/` and rewrites relative imports:
- `from "../agents"` → `from "../agents/index.js"`
- `from "./foo"` → `from "./foo.js"`

This is critical for Node's ESM loader. Always run `npm run build` (which includes this step) before testing the compiled CLI.

## Critical Implementation Details

### Agent Result Structure
All agents return `AgentResult`:
```typescript
{
  agent: string;           // Agent name
  status: AgentStatus;     // success | failure | skipped
  summary: string;         // Brief outcome
  details?: string;        // Extended commentary
  mutations?: FileMutation[]; // File changes (Implementer only)
}
```

### Mutation Flow (Implementer Agent)
1. Scans relevant files with `collectRelevantCode()` - increased from 120 to 200 lines per file, 8KB context budget
2. Prompts LLM with **strong emphasis on anchor-based edits** over unified diffs
3. Parses JSON response with extensive repair pipeline:
   - Up to 2 automatic repair attempts (increased from 1)
   - Multiple extraction strategies (balanced JSON, best-effort parsing)
   - Increased max output tokens to 4096+ for complex changes
4. Applies changes via `FileSystemTool.write()` with anchor-based modifications (replace/insert_after/insert_before)
5. Falls back to unified diff patching with progressive fuzz factors (0, 2, 4) if anchors unavailable
6. Manual patch application as absolute last resort (moved from first to last in fallback chain)
7. Records mutations for rollback with detailed debug logging

### Ink UI State Management
`src/ui/App.tsx` uses React `useReducer` for:
- `input` - User's current text input
- `working` - Whether pipeline is running
- `messages` - Event log (system, plan, progress, result, error)
- `plan` - TODO list with step statuses (pending/done)
- `tokensPrompt`, `tokensCompletion` - Token usage counters

**UI Layout (src/ui/App.tsx:582-621)**:
- **Fixed 3-section design**: Welcome banner → Scrollable messages (`flexGrow={1}` with `overflow="hidden"`) → Fixed bottom section (`flexShrink={0}`)
- **Input box stays anchored** at bottom (doesn't scroll with messages)
- **Footer at very bottom** with enhanced token display:
  - Format: `Tokens: 1,234 prompt + 567 completion = 1,801 total | Context: 0.9% of 128,000`
  - White bold text with color-coded numbers (cyan prompt, green completion, yellow total, magenta percentage)
- **Plan view (33% width)** renders side-by-side with messages when plan exists

**Multi-Line Input Box (src/ui/App.tsx:313-343)**:
- **Max 5 visible lines** - prevents UI expansion with long pastes
- **Auto-scrolling**: Shows last 5 lines when content exceeds max (e.g., "↑ 3 more lines above...")
- **Paste-friendly**: Accepts multi-line paste without breaking layout
- **Consistent styling**: `borderStyle="single"`, `borderColor="gray"`, white bold label
- **Clear hints**: "Shift+Enter: new line | Enter: submit | Esc: exit"

**Plan Tracking (src/ui/App.tsx:87-105)**:
- `complete-plan-step` action now accepts `value` for multi-step completion
- Implementer reports `completedPlanSteps` based on files modified (src/agents/implementer-agent.ts:206-216)
- UI marks N steps as done per agent completion (fixes issue where 5 agents couldn't check off 6 todos)

### Configuration (`src/config/settings.ts`)
Loads from environment variables + `.env` file:
- `OPENAI_API_KEY` - Required; prompted if missing
- `OPENAI_BASE_URL` - Optional custom endpoint
- `OPENAI_MODEL` - Defaults to `gpt-4.1-mini`
- `MYAIDE_WORKSPACE` - Optional default workspace

Runtime settings include `workspaceRoot`, `dryRun`, `verbose`.

## myAIDE.md File Structure
The generated myAIDE.md includes:
1. Project Overview - Purpose, domain, key features
2. Architecture & Design Patterns - High-level structure, frameworks
3. Tech Stack - Languages, frameworks, libraries, build tools
4. Code Organization - Directory structure with explanations
5. Key Conventions - Naming patterns, code style, architectural rules
6. Development Workflow - Build commands, testing strategy
7. Important Constraints - Performance, security, compatibility needs
8. Entry Points - Main files, configuration files

This file is automatically created on first run and read on subsequent runs to provide consistent context to all agents.

## Common Gotchas

1. **Import Extensions** - If you add new TypeScript files, ensure `scripts/fix-imports.js` covers the import paths, or manually add `.js` extensions in compiled output.

2. **Ink Rendering** - Ink requires React. If you modify `src/ui/App.tsx`, remember:
   - Use `useApp()` hook for `exit()`
   - `useInput()` for raw key handling
   - State updates must go through reducer actions

3. **Agent Context Mutations** - `AgentContext.artifacts` is mutable across agents; use it to pass structured data (e.g., Decision Engine stores `workspaceSummary`, `decisionResult`). Mutating `context.plan` directly is allowed but prefer going through Planner.

4. **Shell Tool** - `src/tools/shell.ts` wraps `child_process.spawn`. Always set `cwd` to workspace root to avoid escaping the sandbox.

5. **Implementer JSON Issues** (recently fixed in src/agents/implementer-agent.ts:144-196):
   - System prompt now **strongly emphasizes anchor-based edits** to avoid unified diff failures
   - JSON repair attempts increased from 1 to 2 with enhanced prompts
   - Max output tokens raised to 4096+ to prevent truncation
   - If JSON errors persist, request smaller changes or fewer files per turn

6. **Implementer Patch Failures** (recently fixed in src/agents/implementer-agent.ts:668-789):
   - Fuzz factors increased: now tries 0, 2, and 4 (was 0, 1, 2)
   - Manual patch application moved to **last resort** after all fuzzed attempts
   - More comprehensive file context: 200 lines (was 120), 8KB budget (was 4KB)
   - Anchor-based edits are now preferred; LLM instructed to copy anchor.exact VERBATIM

7. **Validation Rollback** - Only triggers if validation command exits with non-zero code. If tests pass but you need manual rollback, implement a custom validation script that fails on specific conditions.

## Testing New Agents

To add a new agent:
1. Extend `Agent` base class in `src/agents/your-agent.ts`
2. Implement `run(): Promise<AgentResult>`
3. Export from `src/agents/index.ts`
4. Register in `Orchestrator.defaultPipeline()` (src/orchestrator.ts)
5. Add factory function: `(context) => new YourAgent(context)`

Test by running `npm run dev` and submitting a request that triggers your agent's logic.

## OpenAI Client (`src/llm/openai-client.ts`)

Wraps OpenAI SDK with:
- Automatic token usage tracking (updates `context.usage`)
- System + user message construction
- Streaming support (for future enhancements)
- Model defaults to `gpt-4.1-mini` but respects `OPENAI_MODEL` override

When prompting, always include:
- Workspace summary (from `context.artifacts.workspaceSummary`)
- User request
- Relevant code snippets (from code-scan)
- Prior agent results (from `context.history`)

## TypeScript Configuration

- **Target**: ES2020, **Module**: ESNext
- **Module Resolution**: bundler (aligns with Ink + React typings)
- **JSX**: react-jsx (Ink uses React)
- **Strict**: true (all strict checks enabled)
- **Output**: dist/ with .d.ts declarations

Ensure `"type": "module"` in package.json stays set for ESM.

## Dependencies

- **commander** - CLI argument parsing
- **ink** + **ink-text-input** - React-based terminal UI
- **openai** - OpenAI SDK
- **diff** - Unified diff generation for mutations
- **jsonrepair** - Auto-fix malformed JSON from LLM
- **kleur** - Terminal colors
- **dotenv** - Load .env files
- **zod** - Schema validation (used in some agents)

Dev dependencies: `tsx` (TypeScript executor), `typescript`, `rimraf`, `@types/node`, `@types/react`.

## Workspace Safety Constraints

- All file operations via `FileSystemTool` enforce path sandboxing (rejects `..` escapes)
- Shell commands run with `cwd` set to workspace root
- No direct filesystem access; agents must use `context.filesystem`
- Mutations are previewed with diff snippets before applying (in prompt mode)
- Dry-run mode allows testing without writes
- Don't simplify
- Don't use mock data
- the goal is to fix without compromising quality or change process, not without user approval