import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createGatewayRuntime } from "../src/gateway";
import { createApplication } from "../src/runtime";
import type { Provider, ProviderInput, ProviderResponse } from "../src/types";

class ScriptedProvider implements Provider {
  public readonly name = "gateway-lineage-provider";
  public generate(input: ProviderInput): Promise<ProviderResponse> {
    void input;
    return Promise.resolve({
      kind: "final",
      message: "ok",
      usage: { inputTokens: 1, outputTokens: 1 }
    });
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

describe("gateway session lineage", () => {
  it("reuses latest runtime user and previous task for resume-latest continuation", async () => {
    const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-lineage-"));
    tempPaths.push(workspaceRoot);
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") },
      provider: new ScriptedProvider()
    });
    try {
      const gateway = createGatewayRuntime(handle);
      const adapter = {
        adapterId: "lineage-sdk",
        capabilities: {
          approvalInteraction: { supported: false },
          attachmentCapability: { supported: false },
          fileCapability: { supported: false },
          streamingCapability: { supported: false },
          structuredCardCapability: { supported: false },
          textInteraction: { supported: true }
        },
        description: "lineage adapter",
        displayName: "lineage adapter",
        kind: "sdk" as const,
        lifecycleState: "running" as const
      };

      const first = await gateway.submitTask(adapter, {
        requester: {
          externalSessionId: "session-1",
          externalUserId: null,
          externalUserLabel: null
        },
        taskInput: "first"
      });
      const second = await gateway.submitTask(adapter, {
        requester: {
          externalSessionId: "session-1",
          externalUserId: null,
          externalUserLabel: null
        },
        taskInput: "second"
      });

      const secondSnapshot = gateway.getTaskSnapshot(second.result.taskId);
      const received = secondSnapshot?.trace.find((trace) => trace.eventType === "gateway_request_received");
      expect(first.sessionBinding.runtimeUserId).toBe("lineage-sdk:session:session-1");
      expect(second.sessionBinding.runtimeUserId).toBe("lineage-sdk:session:session-1");
      expect(received?.eventType).toBe("gateway_request_received");
      if (received?.eventType === "gateway_request_received") {
        expect(received.payload.previousTaskId).toBe(first.result.taskId);
      }
    } finally {
      handle.close();
    }
  });
});
