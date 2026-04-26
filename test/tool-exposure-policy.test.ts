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
      availability: new Map([["file_read", { available: false, reason: "disabled" }]]),
      budgetDowngradeActive: false,
      tools
    });

    expect(decisions[0]).toMatchObject({
      exposed: false,
      reason: "unavailable: disabled",
      toolName: "file_read"
    });
  });

  it("keeps mutation tools exposed on the first iteration when available", () => {
    const tools = [
      createTool({
        capability: "filesystem.write",
        name: "file_write",
        riskLevel: "medium",
        sideEffectLevel: "workspace_mutation"
      }),
      createTool({
        capability: "shell.execute",
        name: "shell",
        riskLevel: "high",
        sideEffectLevel: "external_mutation"
      }),
      createTool({
        capability: "shell.execute",
        name: "test_run",
        riskLevel: "high",
        sideEffectLevel: "workspace_mutation"
      })
    ];

    const decisions = evaluateToolExposure({
      availability: new Map(
        tools.map((tool) => [tool.name, { available: true, reason: "ok" }] as const)
      ),
      budgetDowngradeActive: false,
      tools
    });

    expect(decisions.every((decision) => decision.exposed)).toBe(true);
    expect(decisions.map((decision) => decision.reason)).toEqual(["eligible", "eligible", "eligible"]);
  });

  it("flags expensive tools during budget downgrade without hiding them", () => {
    const tools = [createTool({ costLevel: "expensive", name: "mcp__docs__search" })];
    const decisions = evaluateToolExposure({
      availability: new Map([["mcp__docs__search", { available: true, reason: "ok" }]]),
      budgetDowngradeActive: true,
      tools
    });

    expect(decisions[0]?.exposed).toBe(true);
    expect(decisions[0]?.costWarning).toBe(true);
    expect(decisions[0]?.reason).toBe("budget downgrade active");
  });

  it("keeps public web fetch exposed when available", () => {
    const tools = [
      createTool({
        capability: "network.fetch_public_readonly",
        name: "web_fetch",
        riskLevel: "medium",
        sideEffectLevel: "external_read_only"
      })
    ];
    const decisions = evaluateToolExposure({
      availability: new Map([["web_fetch", { available: true, reason: "ok" }]]),
      budgetDowngradeActive: false,
      tools
    });

    expect(decisions[0]?.exposed).toBe(true);
    expect(decisions[0]?.reason).toBe("eligible");
  });
});
