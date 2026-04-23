import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startLocalWebhookGateway } from "../src/gateway/index.js";
import { createApplication } from "../src/runtime/index.js";
import type { Provider, ProviderInput, ProviderResponse } from "../src/types/index.js";

class ImmediateProvider implements Provider {
  public readonly name = "immediate-provider";

  public async generate(_input: ProviderInput): Promise<ProviderResponse> {
    return {
      kind: "final",
      message: "ok",
      usage: {
        inputTokens: 1,
        outputTokens: 1
      }
    };
  }
}

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (path !== undefined) {
      await fs.rm(path, { force: true, recursive: true });
    }
  }
});

describe("gateway inbox endpoints", () => {
  it("reads and marks inbox items through webhook adapter", async () => {
    const workspace = await fs.mkdtemp(join(tmpdir(), "talon-gateway-inbox-"));
    tempPaths.push(workspace);
    const handle = createApplication(workspace, {
      config: { databasePath: join(workspace, "runtime.db") },
      provider: new ImmediateProvider()
    });
    const gateway = await startLocalWebhookGateway(handle, { host: "127.0.0.1", port: 39215 });
    try {
      await fetch("http://127.0.0.1:39215/tasks", {
        body: JSON.stringify({
          requester: {
            externalSessionId: "s1",
            externalUserId: "u1",
            externalUserLabel: null
          },
          taskInput: "hello"
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST"
      });

      const listResponse = await fetch("http://127.0.0.1:39215/inbox");
      expect(listResponse.ok).toBe(true);
      const items = (await listResponse.json()) as Array<{ inboxId: string }>;
      expect(items.length).toBeGreaterThan(0);

      const doneResponse = await fetch(`http://127.0.0.1:39215/inbox/${items[0]!.inboxId}/done`, {
        body: JSON.stringify({ reviewerRuntimeUserId: "reviewer-1" }),
        headers: { "Content-Type": "application/json" },
        method: "POST"
      });
      expect(doneResponse.ok).toBe(true);
    } finally {
      await gateway.manager.stopAll();
      handle.close();
    }
  });
});
