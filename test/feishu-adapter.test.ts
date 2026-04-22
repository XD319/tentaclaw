import { describe, expect, it, vi } from "vitest";

import { FeishuAdapter } from "../src/gateway";

describe("feishu adapter", () => {
  it("maps message event to runtime submitTask", async () => {
    const create = vi.fn(() => Promise.resolve({ data: { message_id: "m1" } }));
    const patch = vi.fn(() => Promise.resolve({}));
    const start = vi.fn();
    const submitTask = vi.fn(() => Promise.resolve({
      adapter: {
        adapterId: "feishu-im",
        capabilities: {
          approvalInteraction: { supported: true },
          attachmentCapability: { supported: true },
          fileCapability: { supported: true },
          streamingCapability: { supported: true },
          structuredCardCapability: { supported: true },
          textInteraction: { supported: true }
        },
        description: "x",
        displayName: "x",
        kind: "sdk" as const,
        lifecycleState: "running" as const
      },
      notices: [],
      result: { errorCode: null, errorMessage: null, output: "ok", status: "succeeded", taskId: "t1" },
      sessionBinding: {
        adapterId: "feishu-im",
        createdAt: new Date().toISOString(),
        externalSessionId: "chat",
        externalUserId: "open",
        metadata: {},
        runtimeUserId: "feishu-im:open",
        sessionBindingId: "s1",
        taskId: "t1",
        updatedAt: new Date().toISOString()
      }
    }));

    const adapter = new FeishuAdapter(
      { appId: "app", appSecret: "secret", domain: "feishu" },
      {
        createClients: () => Promise.resolve({
          client: { im: { message: { create, patch } } },
          wsClient: { start }
        })
      }
    );
    await adapter.start({
      runtimeApi: {
        getTaskSnapshot: () => null,
        registerOutboundAdapter: () => undefined,
        resolveApproval: vi.fn(() => Promise.resolve(null)),
        submitTask,
        subscribeToCompletion: () => () => undefined,
        subscribeToTaskEvents: () => () => undefined
      }
    });

    await adapter.handleMessageEvent({
      chatId: "chat",
      openId: "open",
      text: "hello"
    });

    expect(submitTask).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });
});
