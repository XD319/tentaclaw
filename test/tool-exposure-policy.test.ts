import { describe, expect, it } from "vitest";

import { evaluateToolExposure } from "../src/tools/policy/tool-exposure-policy.js";
import type { ToolDefinition } from "../src/types/index.js";

function createTool(partial: Partial<ToolDefinition> & { name: string }): ToolDefinition {
  return {
    approvalDefault: "when_needed",
    capability: "filesystem.read",
    costLevel: "cheap",
    description: partial.name,
    execute: () => Promise.resolve({ output: {}, success: true, summary: "ok" }),
    inputSchema: {} as never,
    inputSchemaDescriptor: { type: "object" },
    name: partial.name,
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
    toolKind: "runtime_primitive",
    ...partial
  };
}

describe("tool exposure policy", () => {
  it("hides unavailable tools", () => {
    const tools = [createTool({ name: "file_read" })];
    const decisions = evaluateToolExposure({
      allowedToolNames: ["file_read"],
      availability: new Map([["file_read", { available: false, reason: "disabled" }]]),
      budgetDowngradeActive: false,
      iteration: 1,
      taskInput: "read files",
      threadCommitmentState: null,
      tools
    });
    expect(decisions[0]?.exposed).toBe(false);
  });

  it("flags expensive tools during budget downgrade", () => {
    const tools = [createTool({ costLevel: "expensive", name: "web_fetch" })];
    const decisions = evaluateToolExposure({
      allowedToolNames: ["web_fetch"],
      availability: new Map([["web_fetch", { available: true, reason: "ok" }]]),
      budgetDowngradeActive: true,
      iteration: 2,
      taskInput: "fetch docs",
      threadCommitmentState: null,
      tools
    });
    expect(decisions[0]?.exposed).toBe(true);
    expect(decisions[0]?.costWarning).toBe(true);
  });

  it("hides high risk tools on first iteration without mutation intent", () => {
    const tools = [createTool({ name: "shell", riskLevel: "high" })];
    const decisions = evaluateToolExposure({
      allowedToolNames: ["shell"],
      availability: new Map([["shell", { available: true, reason: "ok" }]]),
      budgetDowngradeActive: false,
      iteration: 1,
      taskInput: "analyze code quality",
      threadCommitmentState: null,
      tools
    });
    expect(decisions[0]?.exposed).toBe(false);
  });
});
