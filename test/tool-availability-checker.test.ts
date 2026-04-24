import { describe, expect, it } from "vitest";

import { checkToolAvailability } from "../src/tools/availability/tool-availability-checker.js";
import type { ToolDefinition, ToolExecutionContext } from "../src/types/index.js";

describe("tool availability checker", () => {
  it("uses tool checkAvailability when present", async () => {
    const tool = {
      approvalDefault: "when_needed",
      capability: "filesystem.read",
      checkAvailability: () => ({ available: false, reason: "missing binary" }),
      costLevel: "cheap",
      description: "t",
      execute: () => Promise.resolve({ output: {}, success: true, summary: "ok" }),
      inputSchema: {} as never,
      inputSchemaDescriptor: { type: "object" },
      name: "tool_a",
      prepare: () => ({
        governance: { pathScope: "workspace", summary: "ok" },
        preparedInput: {},
        sandbox: {
          kind: "file",
          operation: "read",
          pathScope: "workspace",
          requestedPath: ".",
          resolvedPath: ".",
          withinExtraWriteRoot: false
        }
      }),
      privacyLevel: "internal",
      riskLevel: "low",
      sideEffectLevel: "read_only",
      toolKind: "runtime_primitive"
    } satisfies ToolDefinition;
    const context: ToolExecutionContext = {
      agentProfileId: "executor",
      cwd: process.cwd(),
      iteration: 1,
      signal: new AbortController().signal,
      taskId: "task-1",
      userId: "u1",
      workspaceRoot: process.cwd()
    };
    const availability = await checkToolAvailability([tool], context);
    expect(availability.get("tool_a")?.available).toBe(false);
  });
});
