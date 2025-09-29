import { promises as fs } from "node:fs";
import path from "node:path";

export class FileSystemToolError extends Error {}

export type MutationAction = "write" | "delete";

export interface PendingMutation {
  action: MutationAction;
  path: string;
  preview?: string;
  before?: string;
  after?: string;
}

export interface FileMutation extends PendingMutation {
  applied: boolean;
  reason?: string;
}

export type MutationConfirm = (mutation: PendingMutation) => Promise<boolean> | boolean;

export interface FileSystemToolOptions {
  root: string;
  dryRun?: boolean;
  confirm?: MutationConfirm;
}

export class FileSystemTool {
  private readonly root: string;
  private readonly dryRun: boolean;
  private readonly confirm?: MutationConfirm;

  constructor(options: FileSystemToolOptions) {
    this.root = path.resolve(options.root);
    this.dryRun = Boolean(options.dryRun);
    this.confirm = options.confirm;
  }

  resolve(targetPath: string): string {
    const candidate = path.isAbsolute(targetPath) ? targetPath : path.join(this.root, targetPath);
    const normalized = path.normalize(candidate);
    const relative = path.relative(this.root, normalized);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new FileSystemToolError(`Path escapes workspace: ${targetPath}`);
    }
    return normalized;
  }

  async read(targetPath: string): Promise<string> {
    const resolved = this.resolve(targetPath);
    try {
      return await fs.readFile(resolved, "utf8");
    } catch (error) {
      throw new FileSystemToolError(`Failed to read ${targetPath}: ${(error as Error).message}`);
    }
  }

  async write(targetPath: string, content: string): Promise<FileMutation> {
    const resolved = this.resolve(targetPath);
    let previousContent: string | undefined;
    try {
      previousContent = await fs.readFile(resolved, "utf8");
    } catch {
      previousContent = undefined;
    }

    const pending: PendingMutation = {
      action: "write",
      path: path.relative(this.root, resolved),
      preview: content.slice(0, 500),
      before: previousContent,
      after: content
    };

    if (this.dryRun) {
      return { ...pending, applied: false, reason: "dry-run" };
    }

    if (this.confirm && !(await this.confirm(pending))) {
      return { ...pending, applied: false, reason: "declined" };
    }

    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf8");
    return { ...pending, applied: true };
  }

  async delete(targetPath: string): Promise<FileMutation> {
    const resolved = this.resolve(targetPath);
    let existingContent: string | undefined;
    try {
      existingContent = await fs.readFile(resolved, "utf8");
    } catch {
      existingContent = undefined;
    }
    const pending: PendingMutation = {
      action: "delete",
      path: path.relative(this.root, resolved),
      before: existingContent
    };

    if (this.dryRun) {
      return { ...pending, applied: false, reason: "dry-run" };
    }

    if (this.confirm && !(await this.confirm(pending))) {
      return { ...pending, applied: false, reason: "declined" };
    }

    await fs.rm(resolved, { recursive: true, force: true });
    return { ...pending, applied: true };
  }

  async list(dir = "."): Promise<string[]> {
    const resolved = this.resolve(dir);
    try {
      const entries = await fs.readdir(resolved);
      return entries.map((entry) => path.join(path.relative(this.root, resolved), entry));
    } catch (error) {
      throw new FileSystemToolError(`Failed to list ${dir}: ${(error as Error).message}`);
    }
  }

  async ensureDirs(...dirs: string[]): Promise<string[]> {
    const created: string[] = [];
    for (const dir of dirs) {
      const resolved = this.resolve(dir);
      if (!this.dryRun) {
        await fs.mkdir(resolved, { recursive: true });
      }
      created.push(path.relative(this.root, resolved));
    }
    return created;
  }
}
