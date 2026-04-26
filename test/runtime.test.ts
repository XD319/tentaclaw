import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createApplication, createDefaultRunOptions } from "../src/runtime/index.js";
import type { LocalPolicyConfig, Provider, ProviderInput, ProviderResponse } from "../src/types/index.js";

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

const APPROVAL_REQUIRED_POLICY_CONFIG: LocalPolicyConfig = {
  defaultEffect: "deny",
  rules: [
    {
      description: "Never allow tools to escape the workspace boundary.",
      effect: "deny",
      id: "deny-outside-workspace",
      match: {
        pathScopes: ["outside_workspace", "outside_write_root"]
      },
      priority: 100
    },
    {
      description: "Planner profile is read-focused and cannot mutate files or run shell.",
      effect: "deny",
      id: "planner-read-only",
      match: {
        agentProfiles: ["planner"],
        capabilities: ["filesystem.write", "shell.execute"]
      },
      priority: 91
    },
    {
      description: "Reviewer profile is read-focused and cannot mutate files or run shell.",
      effect: "deny",
      id: "reviewer-read-only",
      match: {
        agentProfiles: ["reviewer"],
        capabilities: ["filesystem.write", "shell.execute"]
      },
      priority: 90
    },
    {
      description: "File writes are approval-gated for approval-flow tests.",
      effect: "allow_with_approval",
      id: "test-file-write-needs-approval",
      match: {
        capabilities: ["filesystem.write"]
      },
      priority: 80
    },
    {
      description: "Low-risk internal reads are allowed.",
      effect: "allow",
      id: "file-read-allow",
      match: {
        capabilities: ["filesystem.read"],
        pathScopes: ["workspace", "write_root"]
      },
      priority: 70
    }
  ],
  source: "local"
};

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

  it("allows workspace file writes by default without approval", async () => {
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
            message: "Create a workspace file.",
            toolCalls: [
              {
                input: {
                  action: "write_file",
                  content: "workspace-write-default",
                  path: "default-write.md"
                },
                reason: "Verify default workspace write behavior.",
                toolCallId: "default-workspace-write",
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
          message: "default-write.md created",
          usage: {
            inputTokens: 4,
            outputTokens: 4
          }
        };
      })
    });

    try {
      const result = await handle.service.runTask(
        createDefaultRunOptions("create default workspace file", workspaceRoot, handle.config)
      );

      expect(result.error).toBeUndefined();
      expect(result.task.status).toBe("succeeded");
      expect(handle.service.listPendingApprovals()).toHaveLength(0);
      expect(await fs.readFile(join(workspaceRoot, "default-write.md"), "utf8")).toBe(
        "workspace-write-default"
      );

      const policyEvents = handle.service
        .traceTask(result.task.taskId)
        .filter((event) => event.eventType === "policy_decision");
      expect(policyEvents[0]?.payload["matchedRuleId"]).toBe("workspace-file-write-allow");
    } finally {
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

  it("returns an approved result when the resumed task fails after approval", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApprovalShellFailureApplication(workspaceRoot);

    try {
      const initial = await handle.service.runTask(
        createDefaultRunOptions("run failing command after approval", workspaceRoot, handle.config)
      );
      const approval = handle.service.listPendingApprovals()[0];
      expect(approval).toBeDefined();

      const resumed = await handle.service.resolveApproval(
        approval?.approvalId ?? "",
        "allow",
        "reviewer-runtime-failure"
      );

      expect(resumed.approval.status).toBe("approved");
      expect(resumed.error?.code).toBe("tool_execution_error");
      expect(resumed.task.status).toBe("failed");
      expect(resumed.output).toBeNull();

      const details = handle.service.showTask(initial.task.taskId);
      expect(details.approvals[0]?.status).toBe("approved");
      expect(details.toolCalls[0]?.status).toBe("failed");
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

  it("applies policy denies for the planner profile", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApprovalWriteApplication(workspaceRoot);

    try {
      const options = createDefaultRunOptions("planner should not write", workspaceRoot, handle.config);
      options.agentProfileId = "planner";

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

  it("allows explicit workspace-external write roots through approval", async () => {
    const workspaceRoot = await createTempWorkspace();
    const writeRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-write-root-"));
    tempPaths.push(writeRoot);
    const targetPath = join(writeRoot, "external.txt");
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      },
      provider: new ScriptedProvider((input) => {
        const toolMessages = input.messages.filter((message) => message.role === "tool");

        if (toolMessages.length === 0) {
          return {
            kind: "tool_calls",
            message: "Create an external write-root file.",
            toolCalls: [
              {
                input: {
                  action: "write_file",
                  content: "external-write-root",
                  path: targetPath
                },
                reason: "Persist the external file after review.",
                toolCallId: "external-write",
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
          message: "external file created",
          usage: {
            inputTokens: 4,
            outputTokens: 4
          }
        };
      }),
      sandbox: {
        writeRoots: [writeRoot]
      }
    });

    try {
      const initial = await handle.service.runTask(
        createDefaultRunOptions("create external governed file", workspaceRoot, handle.config)
      );

      expect(initial.error).toBeUndefined();
      expect(initial.task.status).toBe("waiting_approval");

      const approval = handle.service.listPendingApprovals()[0];
      expect(approval?.reason).toContain(`Resolved path: ${targetPath}`);
      expect(approval?.reason).toContain("Path scope: write_root");
      expect(approval?.reason).toContain("Extra write root: yes");

      const resumed = await handle.service.resolveApproval(
        approval?.approvalId ?? "",
        "allow",
        "reviewer-write-root"
      );

      expect(resumed.task.status).toBe("succeeded");
      expect(await fs.readFile(targetPath, "utf8")).toBe("external-write-root");
    } finally {
      handle.close();
    }
  });

  it("rolls back a newly created file using the latest rollback artifact", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApprovalWriteApplication(workspaceRoot);

    try {
      const initial = await handle.service.runTask(
        createDefaultRunOptions("create governed file", workspaceRoot, handle.config)
      );
      const approval = handle.service.listPendingApprovals()[0];
      await handle.service.resolveApproval(approval?.approvalId ?? "", "allow", "reviewer-rollback");
      const targetPath = join(workspaceRoot, "governed.txt");
      expect(await fs.readFile(targetPath, "utf8")).toBe("phase-2-governed");

      const rollback = await handle.service.rollbackFileArtifact("last");

      expect(rollback.deleted).toBe(true);
      await expect(fs.access(targetPath)).rejects.toThrow();
      expect(handle.service.traceTask(initial.task.taskId).some((event) => event.eventType === "file_rollback")).toBe(true);
      expect(handle.service.auditTask(initial.task.taskId).some((entry) => entry.action === "file_rollback")).toBe(true);
    } finally {
      handle.close();
    }
  });

  it("rolls back an updated file to its original content", async () => {
    const workspaceRoot = await createTempWorkspace();
    const targetPath = join(workspaceRoot, "existing.txt");
    await fs.writeFile(targetPath, "before", "utf8");
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      },
      provider: new ScriptedProvider((input) => {
        const toolMessages = input.messages.filter((message) => message.role === "tool");

        if (toolMessages.length === 0) {
          return {
            kind: "tool_calls",
            message: "Update existing file.",
            toolCalls: [
              {
                input: {
                  action: "update_file",
                  newText: "after",
                  path: "existing.txt",
                  targetText: "before"
                },
                reason: "Update existing file after review.",
                toolCallId: "update-existing",
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
          message: "updated",
          usage: {
            inputTokens: 4,
            outputTokens: 4
          }
        };
      })
    });

    try {
      const result = await handle.service.runTask(
        createDefaultRunOptions("update existing file", workspaceRoot, handle.config)
      );
      expect(await fs.readFile(targetPath, "utf8")).toBe("after");

      const rollbackArtifact = handle.service
        .showTask(result.task.taskId)
        .artifacts.find((artifact) => artifact.artifactType === "file_rollback");
      expect(rollbackArtifact).toBeDefined();

      await handle.service.rollbackFileArtifact(rollbackArtifact?.artifactId ?? "");

      expect(await fs.readFile(targetPath, "utf8")).toBe("before");
    } finally {
      handle.close();
    }
  });

  it("rejects rollback for non-rollback artifacts", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApprovalWriteApplication(workspaceRoot);

    try {
      await handle.service.runTask(
        createDefaultRunOptions("create governed file", workspaceRoot, handle.config)
      );
      const approval = handle.service.listPendingApprovals()[0];
      await handle.service.resolveApproval(approval?.approvalId ?? "", "allow", "reviewer-rollback");
      const fileArtifact = handle.service
        .showTask(approval?.taskId ?? "")
        .artifacts.find((artifact) => artifact.artifactType === "file");
      expect(fileArtifact).toBeDefined();

      await expect(
        handle.service.rollbackFileArtifact(fileArtifact?.artifactId ?? "")
      ).rejects.toMatchObject({
        code: "tool_validation_error"
      });
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
    }),
    policyConfig: APPROVAL_REQUIRED_POLICY_CONFIG
  });
}

function createApprovalShellFailureApplication(workspaceRoot: string) {
  return createApplication(workspaceRoot, {
    config: {
      databasePath: join(workspaceRoot, "runtime.db")
    },
    policyConfig: {
      defaultEffect: "deny",
      rules: [
        {
          description: "Shell commands require reviewer approval in this test.",
          effect: "allow_with_approval",
          id: "test-shell-needs-approval",
          match: {
            capabilities: ["shell.execute"]
          },
          priority: 80
        }
      ],
      source: "local"
    },
    provider: new ScriptedProvider(() => ({
      kind: "tool_calls",
      message: "Run the failing command after approval.",
      toolCalls: [
        {
          input: {
            command: "node --definitely-not-a-node-flag"
          },
          reason: "Exercise resume failure handling after approval.",
          toolCallId: "failing-shell",
          toolName: "shell"
        }
      ],
      usage: {
        inputTokens: 10,
        outputTokens: 5
      }
    }))
  });
}

async function createTempWorkspace(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-phase2-"));
  tempPaths.push(workspaceRoot);
  return workspaceRoot;
}
