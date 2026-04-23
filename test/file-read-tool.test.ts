import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { FileReadTool } from "../src/tools/file-read-tool.js";
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

describe("FileReadTool", () => {
  it("supports offset+limit for read_file", async () => {
    const root = await createTempDir("auto-talon-file-read-");
    const filePath = join(root, "a.txt");
    await fs.writeFile(filePath, "l1\nl2\nl3\nl4\n", "utf8");
    const tool = new FileReadTool(createSandbox(root));

    const prepared = tool.prepare(
      {
        action: "read_file",
        limit: 2,
        offset: 1,
        path: filePath
      },
      createContext(root)
    );

    const result = await tool.execute(prepared.preparedInput, createContext(root));
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected read_file to succeed.");
    }
    const output = result.output as { content: string; endLine: number };
    expect(output.content).toBe("l2\nl3");
    expect(output.endLine).toBe(3);
  });

  it("search_text skips ignored folders and includes context lines", async () => {
    const root = await createTempDir("auto-talon-file-read-");
    await fs.mkdir(join(root, "node_modules"), { recursive: true });
    await fs.writeFile(join(root, "node_modules", "skip.txt"), "needle", "utf8");
    const filePath = join(root, "src.txt");
    await fs.writeFile(filePath, "a\nneedle\nc\n", "utf8");
    const tool = new FileReadTool(createSandbox(root));

    const prepared = tool.prepare(
      {
        action: "search_text",
        contextLines: 1,
        keyword: "needle",
        path: root
      },
      createContext(root)
    );
    const result = await tool.execute(prepared.preparedInput, createContext(root));
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected search_text to succeed.");
    }
    const output = result.output as {
      matches: Array<{ afterContext: string[]; beforeContext: string[]; path: string }>;
    };
    expect(output.matches).toHaveLength(1);
    expect(output.matches[0]?.path).toBe(filePath);
    expect(output.matches[0]?.beforeContext).toEqual(["a"]);
    expect(output.matches[0]?.afterContext).toEqual(["c"]);
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
    taskId: "task-file-read-test",
    userId: "test-user",
    workspaceRoot
  };
}
