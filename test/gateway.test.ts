import { once } from "node:events";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createGatewayRuntime, GatewayManager, startLocalWebhookGateway } from "../src/gateway";
import { createApplication } from "../src/runtime";
import type { LocalPolicyConfig, Provider, ProviderInput, ProviderResponse } from "../src/types";

class ScriptedProvider implements Provider {
  public readonly name = "gateway-scripted-provider";

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
      description: "File writes are approval-gated for gateway approval tests.",
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

describe("Phase 5 gateway adapters", () => {
  it("lets the local webhook adapter create a task and return the linked task id", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      },
      provider: new ScriptedProvider(() => ({
        kind: "final",
        message: "gateway run completed",
        usage: {
          inputTokens: 10,
          outputTokens: 3
        }
      }))
    });

    const port = await getFreePort();
    const gatewayHandle = await startLocalWebhookGateway(handle, {
      host: "127.0.0.1",
      port
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/tasks`, {
        body: JSON.stringify({
          interactionRequirements: {
            streamingCapability: "preferred"
          },
          requester: {
            externalSessionId: "session-1",
            externalUserId: "user-1",
            externalUserLabel: "Local User"
          },
          taskInput: "say hi from gateway"
        }),
        headers: {
          "Content-Type": "application/json"
        },
        method: "POST"
      });

      expect(response.ok).toBe(true);
      const payload = (await response.json()) as {
        result: { output: string | null; status: string; taskId: string };
        sessionBinding: { adapterId: string; externalSessionId: string; runtimeUserId: string };
      };

      expect(payload.result.status).toBe("succeeded");
      expect(payload.result.output).toBe("gateway run completed");
      expect(payload.result.taskId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
      expect(payload.sessionBinding.adapterId).toBe("local-webhook");
      expect(payload.sessionBinding.externalSessionId).toBe("session-1");
      expect(payload.sessionBinding.runtimeUserId).toBe("local-webhook:user-1");
    } finally {
      await gatewayHandle.manager.stopAll();
      handle.close();
    }
  });

  it("records adapter source in trace and audit", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      },
      provider: new ScriptedProvider(() => ({
        kind: "final",
        message: "trace source check",
        usage: {
          inputTokens: 5,
          outputTokens: 2
        }
      }))
    });

    try {
      const gateway = createGatewayRuntime(handle);
      const result = await gateway.submitTask(
        {
          adapterId: "sdk-local",
          capabilities: {
            approvalInteraction: { supported: false },
            attachmentCapability: { supported: false },
            fileCapability: { supported: false },
            streamingCapability: { supported: false },
            structuredCardCapability: { supported: false },
            textInteraction: { supported: true }
          },
          description: "Local SDK adapter",
          displayName: "SDK Adapter",
          kind: "sdk",
          lifecycleState: "running"
        },
        {
          requester: {
            externalSessionId: "sdk-session",
            externalUserId: "sdk-user",
            externalUserLabel: null
          },
          taskInput: "check source propagation"
        }
      );

      const trace = handle.service.traceTask(result.result.taskId);
      const audit = handle.service.auditTask(result.result.taskId);

      expect(
        trace.some(
          (event) =>
            event.eventType === "gateway_request_received" &&
            event.payload.adapterId === "sdk-local"
        )
      ).toBe(true);

      expect(
        audit.some(
          (entry) =>
            entry.action === "gateway_request" &&
            entry.payload.adapterId === "sdk-local" &&
            entry.payload.externalSessionId === "sdk-session"
        )
      ).toBe(true);
    } finally {
      handle.close();
    }
  });

  it("surfaces capability degradation instead of silently failing", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createWaitingApprovalApplication(workspaceRoot);

    try {
      const gateway = createGatewayRuntime(handle);
      const result = await gateway.submitTask(
        {
          adapterId: "sdk-no-approval",
          capabilities: {
            approvalInteraction: { supported: false, detail: "No inline approval flow." },
            attachmentCapability: { supported: false },
            fileCapability: { supported: false },
            streamingCapability: { supported: false, detail: "No SSE support." },
            structuredCardCapability: { supported: false },
            textInteraction: { supported: true }
          },
          description: "SDK adapter without advanced capabilities",
          displayName: "SDK No Approval",
          kind: "sdk",
          lifecycleState: "running"
        },
        {
          interactionRequirements: {
            approvalInteraction: "required",
            streamingCapability: "preferred",
            structuredCardCapability: "preferred"
          },
          requester: {
            externalSessionId: "sdk-session",
            externalUserId: "sdk-user",
            externalUserLabel: null
          },
          taskInput: "create governed file"
        }
      );

      expect(result.result.status).toBe("waiting_approval");
      expect(result.notices.map((notice) => notice.capability)).toContain("approvalInteraction");
      expect(result.notices.map((notice) => notice.capability)).toContain("streamingCapability");

      const snapshot = gateway.getTaskSnapshot(result.result.taskId);
      expect(snapshot?.notices.length).toBeGreaterThanOrEqual(2);
    } finally {
      handle.close();
    }
  });

  it("keeps runtime free of adapter imports", async () => {
    const runtimeSources = [
      "../src/runtime/application-service.ts",
      "../src/runtime/bootstrap.ts",
      "../src/runtime/context-assembler.ts",
      "../src/runtime/execution-kernel.ts",
      "../src/runtime/index.ts",
      "../src/runtime/serialization.ts"
    ];

    for (const runtimeSource of runtimeSources) {
      const content = await fs.readFile(new URL(runtimeSource, import.meta.url), "utf8");
      expect(content.includes("../gateway")).toBe(false);
      expect(content.includes("./gateway")).toBe(false);
      expect(content.includes("adapter")).toBe(false);
    }
  });

  it("streams task history through the webhook event endpoint", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      },
      provider: new ScriptedProvider(() => ({
        kind: "final",
        message: "history ready",
        usage: {
          inputTokens: 5,
          outputTokens: 2
        }
      }))
    });
    const port = await getFreePort();
    const gatewayHandle = await startLocalWebhookGateway(handle, {
      host: "127.0.0.1",
      port
    });

    try {
      const createResponse = await fetch(`http://127.0.0.1:${port}/tasks`, {
        body: JSON.stringify({
          requester: {
            externalSessionId: "stream-session",
            externalUserId: "stream-user",
            externalUserLabel: null
          },
          taskInput: "stream event history"
        }),
        headers: {
          "Content-Type": "application/json"
        },
        method: "POST"
      });
      const created = (await createResponse.json()) as { result: { taskId: string } };

      const eventsResponse = await fetch(
        `http://127.0.0.1:${port}/tasks/${created.result.taskId}/events`
      );
      const body = await eventsResponse.text();

      expect(eventsResponse.ok).toBe(true);
      expect(body).toContain("\"kind\":\"trace\"");
      expect(body).toContain("\"kind\":\"audit\"");
    } finally {
      await gatewayHandle.manager.stopAll();
      handle.close();
    }
  });

  it("fails adapter startup when required capability is missing", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      },
      provider: new ScriptedProvider(() => ({
        kind: "final",
        message: "ok",
        usage: { inputTokens: 1, outputTokens: 1 }
      }))
    });

    try {
      const manager = new GatewayManager(
        createGatewayRuntime(handle),
        [
          {
            descriptor: {
              adapterId: "missing-attachment",
              capabilities: {
                approvalInteraction: { supported: true },
                attachmentCapability: { supported: false },
                fileCapability: { supported: true },
                streamingCapability: { supported: true },
                structuredCardCapability: { supported: true },
                textInteraction: { supported: true }
              },
              description: "test adapter",
              displayName: "test adapter",
              kind: "sdk",
              lifecycleState: "created"
            },
            start: () => Promise.resolve(),
            stop: () => Promise.resolve()
          }
        ],
        {
          requiredCapabilitiesByAdapter: {
            "missing-attachment": {
              attachmentCapability: true
            }
          }
        }
      );
      await expect(manager.startAll()).rejects.toThrow("required capability");
    } finally {
      handle.close();
    }
  });

  it("returns 400 for invalid gateway task payloads", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      },
      provider: new ScriptedProvider(() => ({
        kind: "final",
        message: "unused",
        usage: {
          inputTokens: 1,
          outputTokens: 1
        }
      }))
    });
    const port = await getFreePort();
    const gatewayHandle = await startLocalWebhookGateway(handle, {
      host: "127.0.0.1",
      port
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/tasks`, {
        body: JSON.stringify({
          requester: {
            externalSessionId: "session-1",
            externalUserId: "user-1",
            externalUserLabel: "Local User"
          }
        }),
        headers: {
          "Content-Type": "application/json"
        },
        method: "POST"
      });

      expect(response.status).toBe(400);
      const payload = (await response.json()) as { error: string; message: string };
      expect(payload.error).toBe("invalid_request");
      expect(payload.message).toContain("Invalid input");
    } finally {
      await gatewayHandle.manager.stopAll();
      handle.close();
    }
  });

  it("returns 413 when request body exceeds the configured limit", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      },
      provider: new ScriptedProvider(() => ({
        kind: "final",
        message: "unused",
        usage: {
          inputTokens: 1,
          outputTokens: 1
        }
      }))
    });
    const port = await getFreePort();
    const gatewayHandle = await startLocalWebhookGateway(handle, {
      host: "127.0.0.1",
      port
    });

    try {
      const largeBody = "x".repeat(300_000);
      const response = await fetch(`http://127.0.0.1:${port}/tasks`, {
        body: largeBody,
        headers: {
          "Content-Type": "application/json"
        },
        method: "POST"
      });

      expect(response.status).toBe(413);
      const payload = (await response.json()) as { error: string; message: string };
      expect(payload.error).toBe("payload_too_large");
      expect(payload.message).toContain("byte limit");
    } finally {
      await gatewayHandle.manager.stopAll();
      handle.close();
    }
  });
});

function createWaitingApprovalApplication(workspaceRoot: string) {
  return createApplication(workspaceRoot, {
    config: {
      databasePath: join(workspaceRoot, "runtime.db")
    },
    policyConfig: APPROVAL_REQUIRED_POLICY_CONFIG,
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
                content: "phase-5-governed",
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
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-phase5-"));
  tempPaths.push(workspaceRoot);
  return workspaceRoot;
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Failed to allocate an ephemeral port.");
  }

  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined && error !== null) {
        reject(error);
        return;
      }

      resolve();
    });
  });
  return port;
}
