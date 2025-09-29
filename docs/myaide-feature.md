# myAIDE.md Workspace Context System

## Overview
The myAIDE.md system provides automatic workspace documentation and context management for the multi-agent AI coding assistant. It ensures agents always have comprehensive, up-to-date project knowledge.

## Implementation Files
- **Core Logic**: `src/context/myaide-manager.ts` - MyAIDEManager class
- **Integration**: `src/orchestrator.ts` - handleMyAIDE() method (lines 87-126)
- **Agent Consumption**: `src/agents/implementer-agent.ts` - buildPrompt() method (line 235)

## Three Scenarios

### 1. First Run (No myAIDE.md)
**Flow**:
1. Orchestrator calls `handleMyAIDE()` before running agents
2. MyAIDEManager.getStatus() returns `exists: false`
3. MyAIDEManager.generate() triggers:
   - Workspace scan (depth=3, ~200 files max)
   - Reads package.json, README.md, tsconfig.json, etc.
   - LLM generates comprehensive architecture doc (max 4096 tokens)
4. Content written to `<workspace>/myAIDE.md`
5. Content injected into `artifacts["myAIDEContent"]`
6. User sees: "myAIDE.md created (X tokens used)."

**Token Cost**: ~500-1500 prompt tokens, ~1000-3000 completion tokens

### 2. Subsequent Runs (myAIDE.md exists)
**Flow**:
1. MyAIDEManager.getStatus() returns `exists: true`
2. Content read from disk (cached)
3. MyAIDEManager.detectNeedsUpdate() checks if:
   - package.json modified after myAIDE.md
   - tsconfig.json modified after myAIDE.md
   - Other key config files modified
4. If stale: User sees warning, but execution continues
5. Content loaded into `artifacts["myAIDEContent"]`
6. All agents receive myAIDE.md context in their prompts

**Token Cost**: 0 (reads from disk)

### 3. Change Detection & Refresh
**Flow**:
1. Orchestrator detects stale myAIDE.md
2. Warning displayed: "Consider regenerating with /refresh-myaide"
3. User can:
   - Ignore warning (agents use stale content)
   - Manually delete myAIDE.md and rerun (triggers Scenario 1)
   - Future: Use `/refresh-myaide` command (not yet implemented)

## Agent Integration

### Implementer Agent
**Before**: Only had workspace-summary (top languages, file tree)

**After**: Receives full myAIDE.md content prioritized above workspace-summary
```typescript
const sections = [
  `User request:\n${this.context.request}`,
  `Plan:\n${planText}`,
  myAIDEContent ? `Project Architecture (from myAIDE.md):\n${myAIDEContent}` : "",
  workspaceSummary ? `Workspace summary:\n${workspaceSummary}` : "",
  // ... rest of context
];
```

### Other Agents
All agents can access `context.artifacts["myAIDEContent"]` for grounding decisions in project architecture.

## MyAIDEManager API

### Methods
```typescript
// Check file status
async getStatus(): Promise<MyAIDEStatus>

// Generate from workspace scan
async generate(): Promise<MyAIDEGenerationResult>

// Write to disk
async write(content: string): Promise<void>

// Read (cached)
async read(): Promise<string | null>

// Check if modified since date
async hasChanged(sinceDate: Date): Promise<boolean>

// Detect if needs regeneration
async detectNeedsUpdate(): Promise<boolean>

// Clear internal caches
clearCache(): void
```

### MyAIDEStatus Interface
```typescript
interface MyAIDEStatus {
  exists: boolean;
  path: string;
  content?: string;
  lastModified?: Date;
  needsUpdate?: boolean;
}
```

## Generated myAIDE.md Structure

The LLM generates markdown with these sections:

1. **Project Overview**
   - Purpose and domain
   - Key features
   - Target audience

2. **Architecture & Design Patterns**
   - High-level structure (monolith, microservices, etc.)
   - Framework choices (React, Express, etc.)
   - Design principles (SOLID, DDD, etc.)

3. **Tech Stack**
   - Languages and versions
   - Frameworks and libraries
   - Build tools and package managers

4. **Code Organization**
   - Directory structure with explanations
   - Module boundaries
   - Separation of concerns

5. **Key Conventions**
   - Naming patterns
   - Code style guidelines
   - Architectural rules

6. **Development Workflow**
   - Build commands
   - Test commands
   - Deployment process

7. **Important Constraints**
   - Performance requirements
   - Security considerations
   - Browser/platform compatibility

8. **Entry Points**
   - Main application files
   - Configuration files
   - Where to start reading

## Benefits

1. **Reduced Token Usage**: One-time generation (1-3K tokens) vs repeated workspace scans on every request
2. **Better Context Quality**: LLM-summarized architecture beats raw file lists
3. **Consistency**: All agents share same architectural understanding
4. **Faster Subsequent Runs**: Disk reads vs API calls
5. **User Transparency**: Users can read/edit myAIDE.md manually
6. **Version Control**: myAIDE.md can be committed to git for team sharing

## Future Enhancements

1. **Slash Command**: `/refresh-myaide` to regenerate on demand
2. **Git Integration**: Auto-update when checking out different branches
3. **Incremental Updates**: Append new modules without full regeneration
4. **Multi-Language Support**: Smarter detection for polyglot projects
5. **Custom Templates**: User-defined myAIDE.md structure
6. **Validation**: Ensure generated content meets quality standards

## Testing Scenarios

### Manual Test 1: Fresh Workspace
```bash
cd /path/to/new/project
npm run dev
# Observe: "myAIDE.md not found. Analyzing workspace..."
# Verify: myAIDE.md exists in workspace root
# Verify: Contains project name, languages, key files
```

### Manual Test 2: Existing myAIDE.md
```bash
# With myAIDE.md already present
npm run dev
# Observe: "myAIDE.md found. Checking for changes..."
# Observe: "myAIDE.md is up to date."
```

### Manual Test 3: Stale Detection
```bash
# Edit package.json (add a dependency)
npm run dev
# Observe: "Significant changes detected..."
# Observe: Suggests /refresh-myaide command
```

## Configuration

No user configuration required. System automatically:
- Detects workspace root from orchestrator settings
- Uses default OpenAI model for generation
- Writes to standard location `<workspace>/myAIDE.md`

## Error Handling

- **Generation Failures**: Non-blocking; orchestrator continues without myAIDE.md
- **Read Failures**: Gracefully falls back to workspace-summary
- **Write Failures**: Error logged; user notified
- **Invalid LLM Output**: Markdown sanitization removes fences, cleans formatting

## Performance Impact

| Scenario | Time Impact | Token Impact |
|----------|-------------|--------------|
| First Run | +2-5 seconds | +2000-4500 tokens |
| Subsequent | +50-100ms | 0 tokens |
| Stale Check | +10-20ms | 0 tokens |

## Limitations

1. **Static Analysis Only**: No code execution for dynamic detection
2. **Single File**: Large projects may need multiple context files
3. **LLM Hallucination Risk**: Generated content may be inaccurate
4. **Manual Edits Overwritten**: Regeneration replaces entire file
5. **No Diff Support**: Can't show what changed between versions