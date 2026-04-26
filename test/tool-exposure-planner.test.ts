import { describe, expect, it, vi } from "vitest";

import { ToolExposurePlanner } from "../src/runtime/tool-exposure-planner.js";
import type { ToolDefinition } from "../src/types/index.js";

function makeTool(name: string, riskLevel: "low" | "medium" | "high"): ToolDefinition {
  return {
    approvalDefault: "when_needed",
    capability: "filesystem.read",
    costLevel: "cheap",
    description: name,
    execute: () => Promise.resolve({ output: {}, success: true, summary: "ok" }),
    inputSchema: {} as never,
    inputSchemaDescriptor: { type: "object" },
    name,
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
    riskLevel,
    sideEffectLevel: "read_only",
    toolKind: "runtime_primitive"
  };
}

describe("tool exposure planner", () => {
  it("keeps all available tools exposed and emits trace data", async () => {
    const tools = [makeTool("file_read", "low"), makeTool("shell", "high")];
    const planner = new ToolExposurePlanner({
      budgetService: { isDowngradeActive: () => false } as never,
      toolOrchestrator: {
        listTools: (allowed: string[] | undefined) =>
          tools
            .filter((tool) => allowed === undefined || allowed.includes(tool.name))
            .map((tool) => ({
              capability: tool.capability,
              description: tool.description,
              inputSchema: tool.inputSchemaDescriptor,
              name: tool.name,
              privacyLevel: tool.privacyLevel,
              riskLevel: tool.riskLevel
            })),
        listToolsWithMetadata: () => tools
      } as never,
      traceService: { record: vi.fn() } as never
    });
    const plan = await planner.plan({
      context: {
        agentProfileId: "executor",
        cwd: process.cwd(),
        iteration: 1,
        signal: new AbortController().signal,
        taskId: "task-1",
        userId: "u1",
        workspaceRoot: process.cwd()
      },
      iteration: 1,
      taskId: "task-1",
      threadId: null
    });
    expect(plan.tools.map((tool) => tool.name)).toEqual(["file_read", "shell"]);
  });

  it("hides only tools that fail availability checks", async () => {
    const webFetch = makeTool("web_fetch", "medium");
    webFetch.capability = "network.fetch_public_readonly";
    webFetch.sideEffectLevel = "external_read_only";
    webFetch.checkAvailability = () => ({ available: false, reason: "network disabled" });
    const tools = [makeTool("file_read", "low"), webFetch];
    const planner = new ToolExposurePlanner({
      budgetService: { isDowngradeActive: () => false } as never,
      toolOrchestrator: {
        listTools: (allowed: string[] | undefined) =>
          tools
            .filter((tool) => allowed === undefined || allowed.includes(tool.name))
            .map((tool) => ({
              capability: tool.capability,
              description: tool.description,
              inputSchema: tool.inputSchemaDescriptor,
              name: tool.name,
              privacyLevel: tool.privacyLevel,
              riskLevel: tool.riskLevel
            })),
        listToolsWithMetadata: () => tools
      } as never,
      traceService: { record: vi.fn() } as never
    });

    const plan = await planner.plan({
      context: {
        agentProfileId: "executor",
        cwd: process.cwd(),
        iteration: 1,
        signal: new AbortController().signal,
        taskId: "task-2",
        userId: "u1",
        workspaceRoot: process.cwd()
      },
      iteration: 1,
      taskId: "task-2",
      threadId: null
    });

    expect(plan.tools.map((tool) => tool.name)).toEqual(["file_read"]);
    expect(plan.decisions.find((decision) => decision.toolName === "web_fetch")).toMatchObject({
      exposed: false,
      reason: "unavailable: network disabled"
    });
  });
});
