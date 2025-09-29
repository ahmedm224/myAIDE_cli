import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";

export interface CodeScanItem {
  path: string;
  snippet: string;
  score: number;
}

export interface CodeScanResult {
  items: CodeScanItem[];
  summary: string;
}

interface CandidateFile {
  path: string;
  score: number;
}

const MAX_DEPTH = 5;
const MAX_FILES = 500;
const MAX_FILE_SIZE = 200_000; // ~200KB
const SNIPPET_LINES = 120;

export async function collectRelevantCode(
  request: string,
  workspaceRoot: string,
  limit = 5
): Promise<CodeScanResult> {
  const tokens = buildTokens(request);
  if (!tokens.length) {
    return { items: [], summary: "" };
  }

  const candidates = await gatherCandidateFiles(workspaceRoot, tokens);
  const items: CodeScanItem[] = [];
  for (const candidate of candidates.slice(0, limit)) {
    try {
      const snippet = await readSnippet(path.resolve(workspaceRoot, candidate.path));
      items.push({ path: candidate.path, snippet, score: candidate.score });
    } catch {
      continue;
    }
  }

  const summary = items.length
    ? items
        .map((item) => `- ${item.path} (score ${item.score.toFixed(2)})`)
        .join("\n")
    : "No relevant files detected";

  return { items, summary };
}

function buildTokens(request: string): string[] {
  return Array.from(
    new Set(
      request
        .toLowerCase()
        .split(/[^a-zA-Z0-9_]+/)
        .filter((token) => token.length >= 3 && !COMMON_STOP_WORDS.has(token))
    )
  );
}

async function gatherCandidateFiles(root: string, tokens: string[]): Promise<CandidateFile[]> {
  const candidates: CandidateFile[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let visitedFiles = 0;

  while (queue.length && visitedFiles < MAX_FILES) {
    const { dir, depth } = queue.shift()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryName = entry.name;
      if (shouldSkip(entryName)) {
        continue;
      }
      const fullPath = path.join(dir, entryName);
      const relative = path.relative(root, fullPath) || entryName;

      if (entry.isDirectory()) {
        if (depth + 1 <= MAX_DEPTH) {
          queue.push({ dir: fullPath, depth: depth + 1 });
        }
        continue;
      }

      visitedFiles += 1;
      const fileScore = await scoreFile(fullPath, relative, tokens);
      if (fileScore > 0) {
        candidates.push({ path: relative, score: fileScore });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

async function scoreFile(fullPath: string, relativePath: string, tokens: string[]): Promise<number> {
  const lowerPath = relativePath.toLowerCase();
  let score = 0;
  const lowerTokens = tokens.map((token) => token.toLowerCase());

  // path matches
  for (const token of lowerTokens) {
    if (lowerPath.includes(token)) {
      score += 3;
    }
  }

  try {
    const stats = await fs.stat(fullPath);
    if (stats.size > MAX_FILE_SIZE) {
      return score;
    }
    const content = await fs.readFile(fullPath, "utf8");
    const lowerContent = content.toLowerCase();
    for (const token of lowerTokens) {
      const occurrences = countOccurrences(lowerContent, token);
      if (occurrences > 0) {
        score += Math.min(occurrences, 10);
      }
    }
  } catch {
    // ignore read/stat errors
  }

  return score;
}

async function readSnippet(fullPath: string): Promise<string> {
  const content = await fs.readFile(fullPath, "utf8");
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .slice(0, SNIPPET_LINES)
    .join("\n");
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function shouldSkip(name: string): boolean {
  return name.startsWith(".") || SKIP_DIRS.has(name);
}

const COMMON_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "when",
  "that",
  "this",
  "have",
  "your",
  "about",
  "add",
  "update",
  "feature",
  "code",
  "project",
  "file",
  "files",
  "make",
  "change",
  "changes",
  "implement",
]);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  "coverage",
  ".cache",
]);
