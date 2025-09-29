import { promises as fs } from "node:fs";
import path from "node:path";
import { LLMClient, type ChatMessage } from "../llm/openai-client";
import type { Settings } from "../config/settings";
import { buildWorkspaceSummary, collectWorkspaceSnapshot } from "./workspace-summary";
import type { TokenUsage } from "../agents";

const MYAIDE_FILENAME = "myAIDE.md";

const MYAIDE_GENERATION_PROMPT = `You are an expert software architect analyzing a codebase.
Create a comprehensive myAIDE.md file that future AI coding assistants will use to understand this project.

The myAIDE.md should include:
1. **Project Overview** - Purpose, domain, key features
2. **Architecture & Design Patterns** - High-level structure, frameworks, design principles
3. **Tech Stack** - Languages, frameworks, libraries, build tools
4. **Code Organization** - Directory structure with explanations, module boundaries
5. **Key Conventions** - Naming patterns, code style, architectural rules
6. **Development Workflow** - Build commands, testing strategy, deployment process
7. **Important Constraints** - Performance requirements, security considerations, compatibility needs
8. **Entry Points** - Main files, configuration files, where to start reading

Focus on information that requires understanding multiple files. Avoid listing every file.
Be concise but complete. Use markdown formatting.`;

export interface MyAIDEStatus {
  exists: boolean;
  path: string;
  content?: string;
  lastModified?: Date;
  needsUpdate?: boolean;
}

export interface MyAIDEGenerationResult {
  content: string;
  usage: TokenUsage;
}

/**
 * Manages the myAIDE.md file lifecycle:
 * - Detection
 * - Generation from workspace scan
 * - Reading and context integration
 * - Change detection
 */
export class MyAIDEManager {
  private readonly workspaceRoot: string;
  private readonly myAIDEPath: string;
  private readonly settings: Settings;
  private cachedStatus: MyAIDEStatus | null = null;
  private cachedContent: string | null = null;

  constructor(workspaceRoot: string, settings: Settings) {
    this.workspaceRoot = workspaceRoot;
    this.myAIDEPath = path.join(workspaceRoot, MYAIDE_FILENAME);
    this.settings = settings;
  }

  /**
   * Check if myAIDE.md exists and get its status
   */
  async getStatus(): Promise<MyAIDEStatus> {
    if (this.cachedStatus) {
      return this.cachedStatus;
    }

    try {
      const stats = await fs.stat(this.myAIDEPath);
      const content = await fs.readFile(this.myAIDEPath, "utf8");

      this.cachedStatus = {
        exists: true,
        path: this.myAIDEPath,
        content,
        lastModified: stats.mtime,
        needsUpdate: false
      };
    } catch (error) {
      // File doesn't exist
      this.cachedStatus = {
        exists: false,
        path: this.myAIDEPath
      };
    }

    return this.cachedStatus;
  }

  /**
   * Generate myAIDE.md from workspace analysis
   */
  async generate(): Promise<MyAIDEGenerationResult> {
    const client = new LLMClient(this.settings);

    // Gather comprehensive workspace information
    const summary = await buildWorkspaceSummary(this.workspaceRoot);
    const snapshot = await collectWorkspaceSnapshot(this.workspaceRoot, 3); // Deeper scan

    // Read key configuration files
    const keyFileContents = await this.collectKeyFileContents();

    const messages: ChatMessage[] = [
      { role: "system", content: MYAIDE_GENERATION_PROMPT },
      {
        role: "user",
        content: [
          `Workspace: ${this.workspaceRoot}`,
          `\nWorkspace Summary:\n${summary}`,
          `\nFile Tree (${snapshot.files.length} files):\n${snapshot.tree.slice(0, 100).join("\n")}`,
          keyFileContents ? `\nKey Files:\n${keyFileContents}` : ""
        ]
          .filter(Boolean)
          .join("\n\n")
      }
    ];

    const completion = await client.complete(messages, {
      maxOutputTokens: 4096,
      temperature: 0.3
    });

    const content = this.sanitizeMarkdown(completion.content);

    return {
      content,
      usage: {
        prompt: completion.usagePromptTokens ?? 0,
        completion: completion.usageCompletionTokens ?? 0
      }
    };
  }

  /**
   * Write myAIDE.md to disk
   */
  async write(content: string): Promise<void> {
    await fs.writeFile(this.myAIDEPath, content, "utf8");
    this.cachedStatus = null; // Invalidate cache
    this.cachedContent = content;
  }

  /**
   * Read myAIDE.md content (cached)
   */
  async read(): Promise<string | null> {
    if (this.cachedContent) {
      return this.cachedContent;
    }

    const status = await this.getStatus();
    if (!status.exists || !status.content) {
      return null;
    }

    this.cachedContent = status.content;
    return status.content;
  }

  /**
   * Check if myAIDE.md has been modified since last read
   */
  async hasChanged(sinceDate: Date): Promise<boolean> {
    const status = await this.getStatus();
    if (!status.exists || !status.lastModified) {
      return false;
    }
    return status.lastModified > sinceDate;
  }

  /**
   * Detect if myAIDE.md needs updating based on significant workspace changes
   */
  async detectNeedsUpdate(): Promise<boolean> {
    const status = await this.getStatus();
    if (!status.exists) {
      return true; // Doesn't exist, needs creation
    }

    // Check if package.json or other key files are newer than myAIDE.md
    const keyFiles = ["package.json", "tsconfig.json", "pyproject.toml", "Cargo.toml", "go.mod"];
    const lastModified = status.lastModified!;

    for (const file of keyFiles) {
      const filePath = path.join(this.workspaceRoot, file);
      try {
        const stats = await fs.stat(filePath);
        if (stats.mtime > lastModified) {
          return true;
        }
      } catch {
        // File doesn't exist, skip
        continue;
      }
    }

    return false;
  }

  /**
   * Clear caches (useful for testing or manual refresh)
   */
  clearCache(): void {
    this.cachedStatus = null;
    this.cachedContent = null;
  }

  /**
   * Collect contents of key configuration files
   */
  private async collectKeyFileContents(): Promise<string> {
    const keyFiles = [
      "package.json",
      "README.md",
      "tsconfig.json",
      "pyproject.toml",
      "Cargo.toml",
      "requirements.txt",
      "go.mod",
      "pom.xml"
    ];

    const contents: string[] = [];
    for (const file of keyFiles) {
      const filePath = path.join(this.workspaceRoot, file);
      try {
        const content = await fs.readFile(filePath, "utf8");
        const preview = content.length > 1000 ? content.slice(0, 1000) + "\n..." : content;
        contents.push(`### ${file}\n\`\`\`\n${preview}\n\`\`\``);
      } catch {
        continue;
      }
    }

    return contents.join("\n\n");
  }

  /**
   * Clean up LLM-generated markdown (remove fences if present)
   */
  private sanitizeMarkdown(raw: string): string {
    let cleaned = raw.trim();

    // Remove outer markdown code fences if present
    if (cleaned.startsWith("```markdown") || cleaned.startsWith("```md")) {
      const match = cleaned.match(/^```(?:markdown|md)?\s*([\s\S]*?)```$/i);
      if (match) {
        cleaned = match[1].trim();
      }
    } else if (cleaned.startsWith("```")) {
      const match = cleaned.match(/^```\s*([\s\S]*?)```$/);
      if (match) {
        cleaned = match[1].trim();
      }
    }

    return cleaned;
  }
}