# myAIDE.md Usage Guide

## Quick Start

### First Time Using myaide in a Project

1. **Navigate to your project**:
   ```bash
   cd /path/to/your/project
   ```

2. **Run myaide**:
   ```bash
   npx myaide
   ```

3. **What happens automatically**:
   - ✅ Scans your workspace (files, package.json, README, etc.)
   - ✅ Generates `myAIDE.md` with LLM analysis
   - ✅ Saves file to project root
   - ✅ Loads content into agent context
   - ✅ Shows status message: "myAIDE.md created (X tokens used)."

4. **Enter your request**:
   ```
   Add a new authentication module
   ```

5. **Agents now understand your project**:
   - Architecture patterns
   - Tech stack
   - Code conventions
   - Directory structure

### Subsequent Runs

1. **Run myaide again**:
   ```bash
   npx myaide
   ```

2. **What happens**:
   - ✅ Reads existing `myAIDE.md` from disk (instant)
   - ✅ Checks if workspace changed significantly
   - ✅ Loads content into agents
   - ✅ Shows: "myAIDE.md is up to date."

3. **No extra token cost** - uses cached file

### When myAIDE.md Becomes Stale

If you make major changes (new dependencies, refactoring):

1. **Automatic Detection**:
   ```
   myAIDE.md found. Checking for changes...
   ⚠️  Significant changes detected in workspace configuration.
   Consider regenerating myAIDE.md with '/refresh-myaide' command.
   ```

2. **Manual Regeneration** (current method):
   ```bash
   # Delete the file
   rm myAIDE.md

   # Run myaide again (will regenerate)
   npx myaide
   ```

3. **Future**: `/refresh-myaide` command (not yet implemented)

## What's in myAIDE.md?

The generated file contains:

```markdown
# Project Name

## Project Overview
Brief description of what this project does...

## Architecture & Design Patterns
- Framework: Express.js with TypeScript
- Pattern: MVC with service layer
- Database: PostgreSQL with TypeORM

## Tech Stack
- Node.js 18+
- TypeScript 5.x
- Express 4.x
- React 18 (frontend)

## Code Organization
src/
├── agents/       # Multi-agent system
├── context/      # Workspace analysis
├── decision/     # AI decision engine
├── llm/          # OpenAI client
├── orchestrator/ # Pipeline coordination
└── ui/           # Ink CLI interface

## Key Conventions
- All agents extend Agent base class
- Use async/await for asynchronous operations
- Errors throw Error instances with descriptive messages

## Development Workflow
npm run build    # Compile TypeScript
npm run dev      # Run from source with tsx
npm test         # Run test suite

## Entry Points
- src/cli.ts     # CLI entry point
- src/index.ts   # Public API exports
```

## Best Practices

### ✅ DO:
- Commit `myAIDE.md` to version control
- Regenerate after major refactors
- Edit manually to add project-specific context
- Keep under 4000 tokens for efficiency

### ❌ DON'T:
- Delete unless regenerating
- Put sensitive info (API keys, passwords)
- Expect automatic updates (manual refresh required)
- Rely on it for dynamic runtime info

## Troubleshooting

### myAIDE.md not generated
**Cause**: OpenAI API key missing or invalid

**Fix**:
```bash
export OPENAI_API_KEY=sk-...
npx myaide
```

### Content is outdated
**Cause**: Workspace changed since generation

**Fix**:
```bash
rm myAIDE.md
npx myaide  # Regenerates
```

### Generation takes too long
**Cause**: Very large workspace (1000+ files)

**Fix**: Add `.myaideignore` (future feature) or clean up temp files

### LLM generated incorrect info
**Cause**: Hallucination or insufficient context

**Fix**: Manually edit `myAIDE.md` to correct inaccuracies

## Advanced Usage

### Custom myAIDE.md
You can manually edit the file:

```bash
# Edit with your favorite editor
code myAIDE.md

# myaide will use your edited version
npx myaide
```

Changes persist until you regenerate.

### Multi-Project Workflow
Each project gets its own myAIDE.md:

```bash
cd ~/projects/project-a
npx myaide  # Creates project-a/myAIDE.md

cd ~/projects/project-b
npx myaide  # Creates project-b/myAIDE.md
```

### Skipping myAIDE.md Check
For development/testing:

```javascript
// In code (not exposed via CLI yet)
orchestrator.run(request, observers, memory, artifacts, true); // skipMyAIDECheck=true
```

## Integration with Git

### Recommended .gitignore
Do **NOT** ignore myAIDE.md:

```gitignore
# .gitignore
node_modules/
dist/
.env

# Do NOT add this line:
# myAIDE.md  ❌
```

### Team Collaboration
1. First developer runs myaide (generates myAIDE.md)
2. Commits myAIDE.md to repo
3. Other developers benefit from shared context
4. Update when architecture changes significantly

## Performance Characteristics

| Operation | Time | Tokens | Cost (est.) |
|-----------|------|--------|-------------|
| Generate | 2-5s | 2000-4500 | $0.01-0.02 |
| Read | <100ms | 0 | $0.00 |
| Detect Changes | <20ms | 0 | $0.00 |

## Security Considerations

### What NOT to put in myAIDE.md:
- ❌ API keys or tokens
- ❌ Database credentials
- ❌ Encryption keys
- ❌ Personal data
- ❌ Trade secrets

The LLM should avoid including these, but review the generated file before committing.

### Safe to include:
- ✅ Public architecture patterns
- ✅ Technology stack
- ✅ Directory structure
- ✅ Build commands
- ✅ Code conventions

## Examples

### Example 1: Express API
```markdown
# Express TypeScript API

## Overview
RESTful API for task management with JWT authentication.

## Tech Stack
- Express 4.18
- TypeScript 5.0
- PostgreSQL 15
- Jest for testing

## Key Endpoints
- POST /api/auth/login
- GET /api/tasks
- POST /api/tasks
```

### Example 2: React Frontend
```markdown
# React Dashboard

## Overview
Admin dashboard with real-time metrics and user management.

## Architecture
- Create React App with TypeScript
- Redux Toolkit for state
- React Router v6
- Material-UI components

## State Management
Global state in Redux store, component state in hooks.
```

## Future Roadmap

1. **Phase 1 (Current)**: Auto-generation on first run
2. **Phase 2**: `/refresh-myaide` command
3. **Phase 3**: `.myaideignore` file support
4. **Phase 4**: Incremental updates (append mode)
5. **Phase 5**: Multi-file context (myAIDE/*.md)

## FAQs

**Q: Will myaide work without myAIDE.md?**
A: Yes, but agents have less context. Generation is automatic.

**Q: Can I write myAIDE.md manually?**
A: Yes! Create it yourself to skip generation.

**Q: Does it support monorepos?**
A: Partially. One myAIDE.md per workspace root.

**Q: What if my project has multiple languages?**
A: LLM detects all languages in workspace scan.

**Q: Can I regenerate without deleting?**
A: Not yet - `/refresh-myaide` command coming soon.

**Q: What happens if generation fails?**
A: Non-blocking. Orchestrator continues without myAIDE.md.

## Support

For issues or questions:
- GitHub Issues: https://github.com/your-org/myaide-cli/issues
- Check `docs/myaide-feature.md` for technical details