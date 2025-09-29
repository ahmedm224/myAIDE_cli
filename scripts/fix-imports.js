import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const distDir = path.resolve("dist");

function processFile(filePath) {
  const content = readFileSync(filePath, "utf8");
  const replaced = content
    .replace(/from \"(\.\.\/agents)\"/g, "from \"../agents/index.js\"")
    .replace(/from \"(\.\/agents)\"/g, "from \"./agents/index.js\"")
    .replace(/from \"(\.\.\/[^\"\.]+)\"/g, (match, p1) => `from "${p1}.js"`)
    .replace(/from \"(\.\/[^\"\.]+)\"/g, (match, p1) => `from "${p1}.js"`);
  if (replaced !== content) {
    writeFileSync(filePath, replaced, "utf8");
  }
}

function walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
    } else if (entry.name.endsWith(".js")) {
      processFile(fullPath);
    }
  }
}

try {
  walk(distDir);
} catch (error) {
  console.error("Failed to fix imports", error);
  process.exit(1);
}
