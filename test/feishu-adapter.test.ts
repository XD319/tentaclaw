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

    let handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
    const adapter = new FeishuAdapter(
      { appId: "app", appSecret: "secret", domain: "feishu" },
      {
        createClients: () => Promise.resolve({
          client: { im: { message: { create, patch } } },
          createEventDispatcher: () => ({
            register: (registeredHandlers) => {
              handlers = registeredHandlers;
              return {
                handlers: registeredHandlers
              };
            }
          }),
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

    const payload = {
      event_id: "event-1",
      message: {
        chat_id: "chat",
        content: JSON.stringify({ text: "hello" }),
        message_id: "message-1"
      },
      sender: {
        sender_id: {
          open_id: "open"
        }
      }
    };
    await handlers["im.message.receive_v1"]?.(payload);
    await handlers["im.message.receive_v1"]?.(payload);

    expect(submitTask).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        content: JSON.stringify({ text: "ok" }),
        msg_type: "text",
        receive_id: "chat"
      },
      params: {
        receive_id_type: "chat_id"
      }
    });
    expect(JSON.stringify(create.mock.calls[0]?.[0])).not.toContain("Task Result");
    expect(JSON.stringify(create.mock.calls[0]?.[0])).not.toContain("finished with status");
    expect(JSON.stringify(create.mock.calls[0]?.[0])).not.toContain("interactive");
    expect(patch).not.toHaveBeenCalled();
    await adapter.sendEvent({ detail: "halfway", kind: "progress", taskId: "t1" });
    expect(patch).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("keeps compatibility with wrapped event payloads", async () => {
    const create = vi.fn(() => Promise.resolve({ data: { message_id: "m1" } }));
    const patch = vi.fn(() => Promise.resolve({}));
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

    let handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
    const adapter = new FeishuAdapter(
      { appId: "app", appSecret: "secret", domain: "feishu" },
      {
        createClients: () => Promise.resolve({
          client: { im: { message: { create, patch } } },
          createEventDispatcher: () => ({
            register: (registeredHandlers) => {
              handlers = registeredHandlers;
              return {
                handlers: registeredHandlers
              };
            }
          }),
          wsClient: { start: vi.fn() }
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

    await handlers["im.message.receive_v1"]?.({
      event: {
        event_id: "event-1",
        message: {
          chat_id: "chat",
          content: JSON.stringify({ text: "hello" }),
          message_id: "message-1"
        },
        sender: {
          sender_id: {
            open_id: "open"
          }
        }
      }
    });

    expect(submitTask).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
