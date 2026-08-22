/* global console, process */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const srcRoot = join(repoRoot, "src");

const rules = [
  {
    description: "low-level modules must not import runtime implementation modules",
    from: new Set(["approvals", "mcp", "policy", "providers", "sandbox", "tools"]),
    to: new Set(["runtime"])
  },
  {
    description: "TUI presentation must not import CLI presentation helpers",
    from: new Set(["tui"]),
    to: new Set(["cli"])
  },
  {
    description: "gateway must not import storage modules",
    from: new Set(["gateway"]),
    to: new Set(["storage"])
  },
  {
    description: "TUI presentation must not import storage modules",
    from: new Set(["tui"]),
    to: new Set(["storage"])
  },
  {
    description: "Web HTTP API must not import storage or TUI modules",
    from: new Set(["session-api"]),
    to: new Set(["storage", "tui"])
  }
];

const violations = [];
for (const filePath of walkSourceFiles(srcRoot)) {
  const fromTopLevel = readTopLevel(filePath);
  if (fromTopLevel === null) {
    continue;
  }
  const content = readFileSync(filePath, "utf8");
  for (const specifier of readRelativeSpecifiers(content)) {
    const targetPath = resolve(dirname(filePath), specifier);
    if (!targetPath.startsWith(srcRoot)) {
      continue;
    }
    const toTopLevel = readTopLevel(targetPath);
    if (toTopLevel === null || toTopLevel === fromTopLevel) {
      continue;
    }
    for (const rule of rules) {
      if (rule.from.has(fromTopLevel) && rule.to.has(toTopLevel)) {
        violations.push({
          file: relative(repoRoot, filePath),
          rule: rule.description,
          target: specifier
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Architecture boundary check failed:");
  for (const violation of violations) {
    console.error(`- ${violation.file} imports ${violation.target} (${violation.rule})`);
  }
  process.exit(1);
}

function* walkSourceFiles(directoryPath) {
  for (const entry of readdirSync(directoryPath)) {
    const fullPath = join(directoryPath, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      yield* walkSourceFiles(fullPath);
      continue;
    }
    if (fullPath.endsWith(".ts") || fullPath.endsWith(".tsx")) {
      yield fullPath;
    }
  }
}

function readTopLevel(filePath) {
  const relativePath = relative(srcRoot, filePath);
  if (relativePath.startsWith("..")) {
    return null;
  }
  return relativePath.split(/[\\/]/)[0] ?? null;
}

function readRelativeSpecifiers(content) {
  const specifiers = [];
  const pattern = /from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/gu;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const specifier = match[1] ?? match[2] ?? "";
    if (specifier.startsWith(".")) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}
