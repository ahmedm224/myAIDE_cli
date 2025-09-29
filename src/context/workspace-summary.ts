import path from "node:path";
import { promises as fs } from "node:fs";

const MAX_FILES = 200;
const MAX_PREVIEW_CHARS = 2000;
const IMPORTANT_FILES = [
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "Cargo.toml",
  "requirements.txt",
  "pom.xml"
];

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "out",
  "coverage",
  ".cache"
]);

export interface WorkspaceSnapshot {
  tree: string[];
  files: string[];
}

export async function buildWorkspaceSummary(root: string): Promise<string> {
  const tree = await collectTree(root, 2);
  const languageSummary = summarizeLanguages(tree.files);
  const previews = await collectPreviews(root);

  const sections = [
    `Workspace root: ${root}`,
    `Top languages: ${languageSummary || "unknown"}`,
    "Key files:",
    tree.tree.map((file) => `  - ${file}`).join("\n") || "  (no files discovered)",
    previews ? `\nImportant file excerpts:\n${previews}` : ""
  ];

  return sections.filter(Boolean).join("\n");
}

export async function collectWorkspaceSnapshot(root: string, depth = 2): Promise<WorkspaceSnapshot> {
  return collectTree(root, depth);
}

async function collectTree(
  root: string,
  depth: number,
  current = "."
): Promise<{ tree: string[]; files: string[] }> {
  const tree: string[] = [];
  const files: string[] = [];
  const dirPath = path.resolve(root, current);
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return { tree, files };
  }

  const filtered = entries.filter((entry) => !SKIP_DIRS.has(entry.name) && !entry.name.startsWith("."));
  filtered.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of filtered.slice(0, MAX_FILES)) {
    const relPath = path.join(current, entry.name);
    tree.push(entry.isDirectory() ? `${relPath}/` : relPath);
    if (entry.isDirectory()) {
      if (depth > 0) {
        const nested = await collectTree(root, depth - 1, relPath);
        tree.push(...nested.tree.map((value) => path.join(relPath, value)));
        files.push(...nested.files);
      }
    } else {
      files.push(relPath);
    }
  }

  return { tree, files };
}

function summarizeLanguages(files: string[]): string {
  const counts = new Map<string, number>();
  for (const file of files) {
    const ext = path.extname(file).replace(/^\./, "").toLowerCase();
    if (!ext) continue;
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([ext, count]) => `${ext} (${count})`)
    .join(", ");
}

async function collectPreviews(root: string): Promise<string> {
  const lines: string[] = [];
  for (const file of IMPORTANT_FILES) {
    const filePath = path.join(root, file);
    try {
      const content = await fs.readFile(filePath, "utf8");
      lines.push(`## ${file}\n${truncate(content, MAX_PREVIEW_CHARS)}`);
    } catch {
      continue;
    }
  }
  return lines.join("\n\n");
}

function truncate(content: string, limit: number): string {
  if (content.length <= limit) {
    return content;
  }
  return content.slice(0, limit) + "\n...";
}
