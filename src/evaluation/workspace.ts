import { promises as fs } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SNAPSHOT_SKIP = new Set([".auto-talon", ".git", "node_modules"]);
const HYGIENE_DIRS = [".git", "node_modules"];

export async function seedWorkspace(workspaceRoot: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = safeWorkspacePath(workspaceRoot, path);
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
}

export async function snapshotWorkspace(workspaceRoot: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  await walk(workspaceRoot, workspaceRoot, snapshot, true);
  return snapshot;
}

export async function listHygieneWrites(workspaceRoot: string): Promise<string[]> {
  const writes: string[] = [];
  for (const name of HYGIENE_DIRS) {
    const target = join(workspaceRoot, name);
    try {
      await fs.access(target);
      writes.push(name);
    } catch {
      continue;
    }
  }
  return writes;
}

export async function copyWorkspaceForGrading(sourceRoot: string, gradingRoot: string): Promise<void> {
  await fs.mkdir(gradingRoot, { recursive: true });
  await fs.cp(sourceRoot, gradingRoot, {
    filter: (source) => {
      const relativePath = relative(sourceRoot, source).replaceAll("\\", "/");
      if (relativePath.length === 0) {
        return true;
      }
      const top = relativePath.split("/")[0];
      return top !== ".auto-talon";
    },
    recursive: true
  });
}

export function safeWorkspacePath(workspaceRoot: string, path: string): string {
  const absolute = resolve(workspaceRoot, path);
  const relativePath = relative(resolve(workspaceRoot), absolute);
  if (relativePath.startsWith("..") || relativePath.includes(":")) {
    throw new Error(`Path escapes eval workspace: ${path}`);
  }
  return absolute;
}

async function walk(
  workspaceRoot: string,
  directory: string,
  snapshot: Map<string, string>,
  skipHygiene: boolean
): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (skipHygiene && SNAPSHOT_SKIP.has(entry.name)) {
      continue;
    }
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(workspaceRoot, absolute, snapshot, skipHygiene);
    } else if (entry.isFile()) {
      snapshot.set(relative(workspaceRoot, absolute).replaceAll("\\", "/"), await fs.readFile(absolute, "utf8"));
    }
  }
}
