import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ensureDraftsDir } from "./session-store.js";

export interface ExternalEditorOptions {
  signal?: AbortSignal;
  workspaceRoot: string;
}

export async function editInExternalEditor(
  value: string,
  options: ExternalEditorOptions
): Promise<string> {
  const draftsDir = await ensureDraftsDir(options.workspaceRoot);
  const draftPath = join(draftsDir, `prompt-${randomUUID()}.md`);
  await writeFile(draftPath, value, "utf8");

  try {
    const { command, args } = resolveEditorCommand(draftPath);
    await spawnEditor(command, args, options.signal);
    return await readFile(draftPath, "utf8");
  } finally {
    await unlink(draftPath).catch(() => {});
  }
}

function resolveEditorCommand(draftPath: string): { args: string[]; command: string } {
  const configured = process.env.VISUAL?.trim() || process.env.EDITOR?.trim();
  if (configured !== undefined && configured.length > 0) {
    const [command, ...args] = tokenizeCommand(configured);
    if (command !== undefined) {
      return {
        args: [...args, draftPath],
        command
      };
    }
  }

  if (process.platform === "win32") {
    return {
      args: [draftPath],
      command: "notepad"
    };
  }

  return {
    args: [draftPath],
    command: "vi"
  };
}

function tokenizeCommand(value: string): string[] {
  const parts = value.match(/"[^"]*"|'[^']*'|\S+/gu) ?? [];
  return parts.map((part) => part.replace(/^['"]|['"]$/gu, ""));
}

async function spawnEditor(command: string, args: string[], signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: "inherit"
    });

    const onAbort = () => {
      child.kill();
      reject(new Error("External editor aborted."));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", reject);
    child.on("exit", (code, childSignal) => {
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`External editor exited with code ${code ?? "null"}${childSignal ? ` (${childSignal})` : ""}.`));
    });
  });
}
