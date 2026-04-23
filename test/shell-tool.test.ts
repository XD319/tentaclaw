import { describe, expect, it } from "vitest";

import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { ShellTool } from "../src/tools/shell-tool.js";
import type { ShellCommandExecutor } from "../src/tools/shell/shell-executor.js";
import type { ToolExecutionContext } from "../src/types/index.js";

describe("ShellTool", () => {
  it("returns failure for non-zero exit by default", async () => {
    const tool = new ShellTool(mockExecutor({ exitCode: 2 }), createSandboxService());
    const prepared = tool.prepare({ command: "node -v" }, createContext());
    const result = await tool.execute(prepared.preparedInput, createContext());

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected shell tool to fail for non-zero exit code.");
    }
    expect(result.errorCode).toBe("tool_execution_error");
  });

  it("allows non-zero exit when allowNonZeroExit is true", async () => {
    const tool = new ShellTool(mockExecutor({ exitCode: 3 }), createSandboxService());
    const prepared = tool.prepare(
      { allowNonZeroExit: true, command: "node -v" },
      createContext()
    );
    const result = await tool.execute(prepared.preparedInput, createContext());

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected success when allowNonZeroExit=true.");
    }
    expect((result.output as { exitCode: number }).exitCode).toBe(3);
  });
});

function createSandboxService(): SandboxService {
  return new SandboxService({
    allowedShellCommands: ["node"],
    workspaceRoot: process.cwd()
  });
}

function mockExecutor(overrides: Partial<Awaited<ReturnType<ShellCommandExecutor["execute"]>>>): ShellCommandExecutor {
  return {
    execute: () =>
      Promise.resolve({
        durationMs: 1,
        exitCode: 0,
        stderr: "",
        stderrTruncated: false,
        stdout: "ok",
        stdoutTruncated: false,
        timedOut: false,
        ...overrides
      })
  };
}

function createContext(): ToolExecutionContext {
  return {
    agentProfileId: "executor",
    cwd: process.cwd(),
    iteration: 1,
    signal: new AbortController().signal,
    taskId: "task-shell-tool-test",
    userId: "test-user",
    workspaceRoot: process.cwd()
  };
}
