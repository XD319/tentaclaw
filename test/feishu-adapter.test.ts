import { afterEach, describe, expect, it, vi } from "vitest";

import { FeishuAdapter } from "../src/gateway/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("feishu adapter", () => {
  it("maps message event to runtime submitTask", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
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
      result: { errorCode: null, errorMessage: null, output: "ok", pendingApprovalId: null, status: "succeeded", taskId: "t1" },
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
    expect(info).not.toHaveBeenCalled();
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
      result: { errorCode: null, errorMessage: null, output: "ok", pendingApprovalId: null, status: "succeeded", taskId: "t1" },
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

  it("sends an approval card with the pending approval id", async () => {
    const create = vi.fn(() => Promise.resolve({ data: { message_id: "m1" } }));
    const patch = vi.fn(() => Promise.resolve({}));
    const submitTask = vi.fn(() => Promise.resolve({
      adapter: {
        adapterId: "feishu-im",
        capabilities: {
          approvalInteraction: { supported: true },
          attachmentCapability: { supported: true },
          fileCapability: { supported: true },
          streamingCapability: { supported: false },
          structuredCardCapability: { supported: true },
          textInteraction: { supported: true }
        },
        description: "x",
        displayName: "x",
        kind: "sdk" as const,
        lifecycleState: "running" as const
      },
      notices: [],
      result: {
        errorCode: null,
        errorMessage: null,
        output: null,
        pendingApprovalId: "approval-123",
        status: "waiting_approval",
        taskId: "t1"
      },
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
      event_id: "event-1",
      message: {
        chat_id: "chat",
        content: JSON.stringify({ text: "create file" }),
        message_id: "message-1"
      },
      sender: {
        sender_id: {
          open_id: "open"
        }
      }
    });

    expect(create).toHaveBeenCalledTimes(2);
    const approvalPayload = create.mock.calls[1]?.[0] as
      | { data: { content: string; msg_type: string; receive_id: string } }
      | undefined;
    expect(approvalPayload?.data.msg_type).toBe("interactive");
    expect(approvalPayload?.data.receive_id).toBe("chat");
    expect(approvalPayload?.data.content).toContain("approval-123");
    expect(approvalPayload?.data.content).toContain("\"decision\":\"allow\"");
  });

  it("sends the resumed result after an approval action", async () => {
    const create = vi.fn(() => Promise.resolve({ data: { message_id: "m1" } }));
    const patch = vi.fn(() => Promise.resolve({}));
    const resolveApproval = vi.fn(() => Promise.resolve({
      adapter: {
        adapterId: "feishu-im",
        capabilities: {
          approvalInteraction: { supported: true },
          attachmentCapability: { supported: true },
          fileCapability: { supported: true },
          streamingCapability: { supported: false },
          structuredCardCapability: { supported: true },
          textInteraction: { supported: true }
        },
        description: "x",
        displayName: "x",
        kind: "sdk" as const,
        lifecycleState: "running" as const
      },
      notices: [],
      result: {
        errorCode: null,
        errorMessage: null,
        output: "file created",
        pendingApprovalId: null,
        status: "succeeded",
        taskId: "t1"
      },
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
        resolveApproval,
        submitTask: vi.fn(),
        subscribeToCompletion: () => () => undefined,
        subscribeToTaskEvents: () => () => undefined
      }
    });

    await handlers["card.action.trigger"]?.({
      event: {
        action: {
          value: {
            approvalId: "approval-123",
            decision: "allow",
            taskId: "t1"
          }
        },
        context: {
          open_chat_id: "chat"
        },
        operator: {
          operator_id: {
            open_id: "open"
          }
        }
      }
    });

    expect(resolveApproval).toHaveBeenCalledWith({
      adapterId: "feishu-im",
      approvalId: "approval-123",
      decision: "allow",
      reviewerExternalUserId: "open",
      reviewerRuntimeUserId: "feishu-im:open"
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        content: JSON.stringify({ text: "file created" }),
        msg_type: "text",
        receive_id: "chat"
      },
      params: {
        receive_id_type: "chat_id"
      }
    });
  });
});
