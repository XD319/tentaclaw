import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createApplication, createDefaultRunOptions } from "../src/runtime";
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

describe("Phase 2 governance runtime", () => {
  it("uses a caller-provided task id when supplied", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      },
      provider: new ScriptedProvider(() => ({
        kind: "final",
        message: "fixed id complete",
        usage: {
          inputTokens: 1,
          outputTokens: 1
        }
      }))
    });

    try {
      const options = createDefaultRunOptions("use fixed id", workspaceRoot, handle.config);
      options.taskId = "task-fixed-for-tui";

      const result = await handle.service.runTask(options);

      expect(result.task.taskId).toBe("task-fixed-for-tui");
      expect(handle.service.showTask("task-fixed-for-tui").task?.taskId).toBe("task-fixed-for-tui");
    } finally {
      handle.close();
    }
  });

  it("filters trace subscriptions by task id", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      },
      provider: new ScriptedProvider(() => ({
        kind: "final",
        message: "subscription complete",
        usage: {
          inputTokens: 1,
          outputTokens: 1
        }
      }))
    });
    const receivedEventTaskIds: string[] = [];
    const unsubscribe = handle.service.subscribeToTaskTrace("task-subscription-target", (event) => {
      receivedEventTaskIds.push(event.taskId);
    });

    try {
      const targetOptions = createDefaultRunOptions("target", workspaceRoot, handle.config);
      targetOptions.taskId = "task-subscription-target";
      await handle.service.runTask(targetOptions);

      const otherOptions = createDefaultRunOptions("other", workspaceRoot, handle.config);
      otherOptions.taskId = "task-subscription-other";
      await handle.service.runTask(otherOptions);

      expect(receivedEventTaskIds.length).toBeGreaterThan(0);
      expect(new Set(receivedEventTaskIds)).toEqual(new Set(["task-subscription-target"]));
    } finally {
      unsubscribe();
      handle.close();
    }
  });

  it("routes high-risk tools into approval before execution", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApprovalWriteApplication(workspaceRoot);

    try {
      const result = await handle.service.runTask(
        createDefaultRunOptions("create governed file", workspaceRoot, handle.config)
      );

      expect(result.error).toBeUndefined();
      expect(result.task.status).toBe("waiting_approval");

      const pendingApprovals = handle.service.listPendingApprovals();
      expect(pendingApprovals).toHaveLength(1);
      expect(pendingApprovals[0]?.toolName).toBe("file_write");

      const details = handle.service.showTask(result.task.taskId);
      expect(details.toolCalls).toHaveLength(1);
      expect(details.toolCalls[0]?.status).toBe("awaiting_approval");
    } finally {
      handle.close();
    }
  });

  it("continues a task after approval is granted", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApprovalWriteApplication(workspaceRoot);

    try {
      const initial = await handle.service.runTask(
        createDefaultRunOptions("create governed file", workspaceRoot, handle.config)
      );
      const approval = handle.service.listPendingApprovals()[0];
      expect(approval).toBeDefined();

      const resumed = await handle.service.resolveApproval(
        approval?.approvalId ?? "",
        "allow",
        "reviewer-1"
      );

      expect(resumed.approval.status).toBe("approved");
      expect(resumed.task.status).toBe("succeeded");
      expect(resumed.output).toBe("governed.txt created after approval");
      expect(await fs.readFile(join(workspaceRoot, "governed.txt"), "utf8")).toBe(
        "phase-2-governed"
      );

      const details = handle.service.showTask(initial.task.taskId);
      expect(details.toolCalls[0]?.status).toBe("finished");
      expect(handle.service.traceTask(initial.task.taskId).some((event) => event.eventType === "approval_resolved")).toBe(
        true
      );
    } finally {
      handle.close();
    }
  });

  it("fails the task when approval is denied", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApprovalWriteApplication(workspaceRoot);

    try {
      const initial = await handle.service.runTask(
        createDefaultRunOptions("create governed file", workspaceRoot, handle.config)
      );
      const approval = handle.service.listPendingApprovals()[0];
      expect(approval).toBeDefined();

      const denied = await handle.service.resolveApproval(
        approval?.approvalId ?? "",
        "deny",
        "reviewer-2"
      );

      expect(denied.approval.status).toBe("denied");
      expect(denied.task.status).toBe("failed");
      await expect(fs.access(join(workspaceRoot, "governed.txt"))).rejects.toThrow();

      const details = handle.service.showTask(initial.task.taskId);
      expect(details.toolCalls[0]?.status).toBe("denied");
    } finally {
      handle.close();
    }
  });

  it("applies policy denies for the reviewer profile", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApprovalWriteApplication(workspaceRoot);

    try {
      const options = createDefaultRunOptions("reviewer should not write", workspaceRoot, handle.config);
      options.agentProfileId = "reviewer";

      const result = await handle.service.runTask(options);

      expect(result.error?.code).toBe("policy_denied");
      expect(result.task.status).toBe("failed");
      expect(handle.service.listPendingApprovals()).toHaveLength(0);
    } finally {
      handle.close();
    }
  });

  it("enforces sandbox restrictions on filesystem escape attempts", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      },
      provider: new ScriptedProvider(() => ({
        kind: "tool_calls",
        message: "Attempt to write outside the workspace.",
        toolCalls: [
          {
              input: {
                action: "write_file",
                content: "denied",
                path: "../outside.txt"
              },
            reason: "Verify sandbox path enforcement.",
            toolCallId: "outside-write",
            toolName: "file_write"
          }
        ],
        usage: {
          inputTokens: 8,
          outputTokens: 4
        }
      }))
    });

    try {
      const result = await handle.service.runTask(
        createDefaultRunOptions("attempt to escape the workspace", workspaceRoot, handle.config)
      );

      expect(result.error?.code).toBe("sandbox_denied");
      expect(result.task.status).toBe("failed");

      const auditEntries = handle.service.auditTask(result.task.taskId);
      expect(
        auditEntries.some(
          (entry) => entry.action === "sandbox_enforced" && entry.outcome === "denied"
        )
      ).toBe(true);
    } finally {
      handle.close();
    }
  });

  it("records audit logs for policy, approvals, sandbox, and file writes", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApprovalWriteApplication(workspaceRoot);

    try {
      const initial = await handle.service.runTask(
        createDefaultRunOptions("create governed file", workspaceRoot, handle.config)
      );
      const approval = handle.service.listPendingApprovals()[0];
      expect(approval).toBeDefined();

      await handle.service.resolveApproval(approval?.approvalId ?? "", "allow", "reviewer-3");

      const auditEntries = handle.service.auditTask(initial.task.taskId);
      const actions = auditEntries.map((entry) => entry.action);

      expect(actions).toContain("policy_decision");
      expect(actions).toContain("approval_requested");
      expect(actions).toContain("approval_resolved");
      expect(actions).toContain("sandbox_enforced");
      expect(actions).toContain("file_write");
    } finally {
      handle.close();
    }
  });
});

function createApprovalWriteApplication(workspaceRoot: string) {
  return createApplication(workspaceRoot, {
    config: {
      databasePath: join(workspaceRoot, "runtime.db")
    },
    provider: new ScriptedProvider((input) => {
      const toolMessages = input.messages.filter((message) => message.role === "tool");

      if (toolMessages.length === 0) {
        return {
          kind: "tool_calls",
          message: "Create the governed file.",
          toolCalls: [
            {
              input: {
                action: "write_file",
                content: "phase-2-governed",
                path: "governed.txt"
              },
              reason: "Persist the governed file after review.",
              toolCallId: "governed-write",
              toolName: "file_write"
            }
          ],
          usage: {
            inputTokens: 10,
            outputTokens: 5
          }
        };
      }

      return {
        kind: "final",
        message: "governed.txt created after approval",
        usage: {
          inputTokens: 4,
          outputTokens: 4
        }
      };
    })
  });
}

async function createTempWorkspace(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-phase2-"));
  tempPaths.push(workspaceRoot);
  return workspaceRoot;
}
