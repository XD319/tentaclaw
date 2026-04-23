import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { FileWriteTool } from "../src/tools/file-write-tool.js";
import type { ToolExecutionContext } from "../src/types/index.js";

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined) {
      await fs.rm(tempPath, { force: true, recursive: true });
    }
  }
});

describe("FileWriteTool", () => {
  it("fails update_file when target is ambiguous and replaceAll=false", async () => {
    const root = await createTempDir("auto-talon-file-write-");
    const filePath = join(root, "a.txt");
    await fs.writeFile(filePath, "foo\nfoo\n", "utf8");
    const tool = new FileWriteTool(createSandbox(root));

    const prepared = tool.prepare(
      {
        action: "update_file",
        newText: "bar",
        path: filePath,
        replaceAll: false,
        targetText: "foo"
      },
      createContext(root)
    );
    await expect(tool.execute(prepared.preparedInput, createContext(root))).rejects.toThrow(
      /appears 2 times/i
    );
  });

  it("supports context-aware apply_patch replacements", async () => {
    const root = await createTempDir("auto-talon-file-write-");
    const filePath = join(root, "b.txt");
    await fs.writeFile(filePath, "alpha\nX\nbeta\nalpha\nX\ngamma\n", "utf8");
    const tool = new FileWriteTool(createSandbox(root));

    const prepared = tool.prepare(
      {
        action: "apply_patch",
        patches: [
          {
            afterContext: "\nbeta",
            beforeContext: "alpha\n",
            find: "X",
            replace: "Y",
            replaceAll: false
          }
        ],
        path: filePath
      },
      createContext(root)
    );
    const result = await tool.execute(prepared.preparedInput, createContext(root));
    expect(result.success).toBe(true);
    expect(await fs.readFile(filePath, "utf8")).toBe("alpha\nY\nbeta\nalpha\nX\ngamma\n");
  });

  it("stores full rollback content and writes snapshot reference", async () => {
    const root = await createTempDir("auto-talon-file-write-");
    const filePath = join(root, "large.txt");
    const original = "a".repeat(1_200_000);
    await fs.writeFile(filePath, original, "utf8");
    const tool = new FileWriteTool(createSandbox(root));

    const prepared = tool.prepare(
      {
        action: "update_file",
        newText: "b",
        path: filePath,
        replaceAll: true,
        targetText: "a"
      },
      createContext(root)
    );
    const result = await tool.execute(prepared.preparedInput, createContext(root));

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected write operation to succeed.");
    }
    const rollback = result.artifacts?.find((item) => item.artifactType === "file_rollback");
    expect(rollback).toBeDefined();
    const rollbackContent = rollback?.content as {
      originalContent: string;
      snapshotPath: string;
    };
    expect(rollbackContent.originalContent.length).toBe(original.length);
    const snapshot = await fs.readFile(rollbackContent.snapshotPath, "utf8");
    expect(snapshot.length).toBe(original.length);
  });
});

function createSandbox(workspaceRoot: string): SandboxService {
  return new SandboxService({
    workspaceRoot
  });
}

async function createTempDir(prefix: string): Promise<string> {
  const tempPath = await fs.mkdtemp(join(tmpdir(), prefix));
  tempPaths.push(tempPath);
  return tempPath;
}

function createContext(workspaceRoot: string): ToolExecutionContext {
  return {
    agentProfileId: "executor",
    cwd: workspaceRoot,
    iteration: 1,
    signal: new AbortController().signal,
    taskId: "task-file-write-test",
    userId: "test-user",
    workspaceRoot
  };
}
