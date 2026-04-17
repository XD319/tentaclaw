import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createApplication, createDefaultRunOptions } from "../src/runtime";
import { nextPanel, previousPanel } from "../src/tui/hooks/use-dashboard-controller";
import { RuntimeDashboardQueryService } from "../src/tui/view-models/runtime-dashboard";
import type { Provider, ProviderInput, ProviderResponse } from "../src/types";

class ScriptedProvider implements Provider {
  public readonly name = "scripted-provider";

  public constructor(
    private readonly responder: (input: ProviderInput) => Promise<ProviderResponse> | ProviderResponse
  ) {}

  public async generate(input: ProviderInput): Promise<ProviderResponse> {
    return this.responder(input);
  }
}

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined) {
      await fs.rm(tempPath, { force: true, recursive: true });
    }
  }
});

describe("Phase 4 Ink TUI query models", () => {
  it("surfaces approvals, trace, and diff summaries through the dashboard query model", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      },
      provider: new ScriptedProvider((input) => {
        const toolMessages = input.messages.filter((message) => message.role === "tool");

        if (toolMessages.length === 0) {
          return {
            kind: "tool_calls",
            message: "Create the file after approval.",
            toolCalls: [
              {
                input: {
                  action: "write_file",
                  content: "phase4 hello",
                  path: "phase4.txt"
                },
                reason: "Create an observable file.",
                toolCallId: "phase4-write",
                toolName: "file_write"
              }
            ],
            usage: {
              inputTokens: 8,
              outputTokens: 4
            }
          };
        }

        return {
          kind: "final",
          message: "phase4.txt created",
          usage: {
            inputTokens: 4,
            outputTokens: 4
          }
        };
      })
    });

    try {
      const initial = await handle.service.runTask(
        createDefaultRunOptions("create governed file", workspaceRoot, handle.config)
      );
      const queryService = new RuntimeDashboardQueryService(handle.service);
      const beforeApproval = queryService.getDashboard({
        selectedPanel: "approvals",
        selectedTaskId: initial.task.taskId
      });

      expect(beforeApproval.summary.pendingApprovalCount).toBe(1);
      expect(beforeApproval.pendingApprovals[0]?.toolName).toBe("file_write");
      expect(beforeApproval.selectedTask?.finalSummary).toContain("waiting for reviewer approval");

      await queryService.resolveApproval(
        beforeApproval.pendingApprovals[0]?.approvalId ?? "",
        "allow",
        "reviewer-phase4"
      );

      const afterApproval = queryService.getDashboard({
        selectedPanel: "diff",
        selectedTaskId: initial.task.taskId
      });

      expect(afterApproval.selectedTask?.diff[0]?.path).toContain("phase4.txt");
      expect(afterApproval.selectedTask?.trace.some((entry) => entry.eventType === "approval_resolved")).toBe(
        true
      );
      expect(afterApproval.selectedTask?.diff[0]?.summary).toContain("changed=");
    } finally {
      handle.close();
    }
  });

  it("shows memory hits and failure reasons in the dashboard details", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      },
      provider: new ScriptedProvider((input) => {
        if (input.task.input.includes("remember guidance")) {
          return {
            kind: "final",
            message: "Use vitest and pnpm for this runtime workspace.",
            usage: {
              inputTokens: 10,
              outputTokens: 5
            }
          };
        }

        if (input.task.input.includes("recall guidance")) {
          return {
            kind: "final",
            message: `Context size ${input.memoryContext.length}`,
            usage: {
              inputTokens: 10,
              outputTokens: 5
            }
          };
        }

        return {
          kind: "tool_calls",
          message: "Attempt sandbox escape",
          toolCalls: [
            {
              input: {
                action: "write_file",
                content: "escape",
                path: "..\\outside.txt"
              },
              reason: "Trigger sandbox denial.",
              toolCallId: "sandbox-deny",
              toolName: "file_write"
            }
          ],
          usage: {
            inputTokens: 8,
            outputTokens: 4
          }
        };
      })
    });

    try {
      await handle.service.runTask(
        createDefaultRunOptions("remember guidance", workspaceRoot, handle.config)
      );
      const recall = await handle.service.runTask(
        createDefaultRunOptions("recall guidance", workspaceRoot, handle.config)
      );
      const failed = await handle.service.runTask(
        createDefaultRunOptions("cause sandbox failure", workspaceRoot, handle.config)
      );
      const queryService = new RuntimeDashboardQueryService(handle.service);

      const recallDashboard = queryService.getDashboard({
        selectedPanel: "memory",
        selectedTaskId: recall.task.taskId
      });
      expect(recallDashboard.selectedTask?.memoryHits.length).toBeGreaterThan(0);
      expect(recallDashboard.selectedTask?.memoryHits[0]?.reasons.join(" ")).toContain("included");

      const failureDashboard = queryService.getDashboard({
        selectedPanel: "errors",
        selectedTaskId: failed.task.taskId
      });
      expect(failureDashboard.selectedTask?.errors.some((entry) => entry.code === "sandbox_reject")).toBe(
        true
      );
      expect(failureDashboard.selectedTask?.errors[0]?.message.length).toBeGreaterThan(0);
    } finally {
      handle.close();
    }
  });

  it("cycles panel ids for keyboard navigation", () => {
    expect(nextPanel("tasks")).toBe("approvals");
    expect(previousPanel("tasks")).toBe("errors");
  });
});

async function createTempWorkspace(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "tentaclaw-phase4-"));
  tempPaths.push(workspaceRoot);
  return workspaceRoot;
}
