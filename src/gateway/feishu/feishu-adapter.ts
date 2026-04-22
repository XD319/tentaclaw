import type {
  AdapterDescriptor,
  GatewayCapabilityNotice,
  GatewayRuntimeApi,
  GatewayTaskEvent,
  GatewayTaskLaunchResult,
  GatewayTaskResultView,
  InboundMessageAdapter,
  OutboundResponseAdapter
} from "../../types";
import {
  renderApprovalCard,
  renderTaskProgressCard,
  renderTaskResultCard
} from "./feishu-card";
import type { FeishuGatewayConfig } from "./feishu-config";

interface FeishuClientLike {
  im: {
    message: {
      create: (payload: FeishuCreateMessagePayload) => Promise<{ data?: { message_id?: string } }>;
      patch: (payload: FeishuPatchMessagePayload) => Promise<unknown>;
    };
  };
}

type FeishuCreateMessagePayload = FeishuCreateInteractiveMessagePayload | FeishuCreateTextMessagePayload;

interface FeishuCreateInteractiveMessagePayload {
  data: {
    content: string;
    msg_type: "interactive";
    receive_id: string;
  };
  params: {
    receive_id_type: "chat_id";
  };
}

interface FeishuCreateTextMessagePayload {
  data: {
    content: string;
    msg_type: "text";
    receive_id: string;
  };
  params: {
    receive_id_type: "chat_id";
  };
}

interface FeishuPatchMessagePayload {
  data: {
    content: string;
  };
  path: {
    message_id: string;
  };
}

interface FeishuWsClientLike {
  start: (options: Record<string, unknown>) => Promise<void> | void;
  stop?: () => void;
}

interface FeishuEventDispatcherLike {
  register: (handlers: Record<string, (data: unknown) => Promise<void> | void>) => unknown;
}

export interface FeishuAdapterOptions {
  adapterId?: string;
  createClients?: (config: FeishuGatewayConfig) => Promise<{
    client: FeishuClientLike;
    createEventDispatcher: () => FeishuEventDispatcherLike;
    wsClient: FeishuWsClientLike;
  }>;
}

export class FeishuAdapter implements InboundMessageAdapter, OutboundResponseAdapter {
  public readonly descriptor: AdapterDescriptor;

  private runtimeApi: GatewayRuntimeApi | null = null;
  private client: FeishuClientLike | null = null;
  private wsClient: FeishuWsClientLike | null = null;
  private readonly handledInboundKeys: string[] = [];
  private readonly handledInboundKeySet = new Set<string>();
  private readonly taskMessageIds = new Map<string, { chatId: string; messageId: string }>();

  public constructor(
    private readonly config: FeishuGatewayConfig,
    private readonly options: FeishuAdapterOptions = {}
  ) {
    this.descriptor = {
      adapterId: options.adapterId ?? "feishu-im",
      capabilities: {
        approvalInteraction: { supported: true },
        attachmentCapability: { supported: true },
        fileCapability: { supported: true },
        streamingCapability: { supported: true },
        structuredCardCapability: { supported: true },
        textInteraction: { supported: true }
      },
      description: "Feishu long-connection adapter for chat ingress and approval callbacks.",
      displayName: "Feishu Adapter",
      kind: "sdk",
      lifecycleState: "created"
    };
  }

  public async start(context: { runtimeApi: GatewayRuntimeApi }): Promise<void> {
    this.runtimeApi = context.runtimeApi;
    const clients =
      this.options.createClients === undefined
        ? await createDefaultClients(this.config)
        : await this.options.createClients(this.config);
    this.client = clients.client;
    this.wsClient = clients.wsClient;
    const eventDispatcher = clients.createEventDispatcher().register({
      "card.action.trigger": async (payload) => {
        try {
          await this.handleCardActionEvent(parseCardActionEvent(payload));
        } catch (error) {
          console.error("[feishu-adapter] failed to handle card.action.trigger", error);
        }
      },
      "im.message.receive_v1": async (payload) => {
        try {
          console.info("[feishu-adapter] received im.message.receive_v1", summarizeMessagePayload(payload));
          const event = parseMessageEvent(payload);
          if (event === null) {
            console.warn("[feishu-adapter] ignored message event because payload is missing chat/text");
            return;
          }
          const inboundKey = event.messageId ?? event.eventId;
          if (inboundKey !== null && !this.markInboundMessageSeen(inboundKey)) {
            console.info("[feishu-adapter] ignored duplicate message event", { inboundKey });
            return;
          }
          console.info("[feishu-adapter] submitting message task", {
            chatId: event.chatId,
            eventId: event.eventId,
            hasOpenId: event.openId !== null,
            messageId: event.messageId,
            textLength: event.text.length
          });
          await this.handleMessageEvent(event);
        } catch (error) {
          console.error("[feishu-adapter] failed to handle im.message.receive_v1", error);
        }
      }
    });
    await this.wsClient.start({
      eventDispatcher
    });
  }

  public stop(): Promise<void> {
    this.wsClient?.stop?.();
    this.wsClient = null;
    this.client = null;
    this.runtimeApi = null;
    return Promise.resolve();
  }

  private markInboundMessageSeen(inboundKey: string): boolean {
    if (this.handledInboundKeySet.has(inboundKey)) {
      return false;
    }
    this.handledInboundKeySet.add(inboundKey);
    this.handledInboundKeys.push(inboundKey);
    while (this.handledInboundKeys.length > 500) {
      const oldest = this.handledInboundKeys.shift();
      if (oldest !== undefined) {
        this.handledInboundKeySet.delete(oldest);
      }
    }
    return true;
  }

  public async handleMessageEvent(event: {
    chatId: string;
    eventId: string | null;
    messageId: string | null;
    openId: string | null;
    text: string;
  }): Promise<void> {
    if (this.runtimeApi === null || this.client === null) {
      return;
    }
    const trimmed = event.text.trim();
    if (trimmed.length === 0) {
      return;
    }

    const result = await this.runtimeApi.submitTask(this.descriptor, {
      continuation: trimmed.startsWith("/new ") ? "new" : "resume-latest",
      requester: {
        externalSessionId: event.chatId,
        externalUserId: event.openId,
        externalUserLabel: null
      },
      taskInput: trimmed.replace(/^\/new\s+/, "")
    });

    const sent = await this.client.im.message.create(
      createTextMessagePayload(event.chatId, formatTaskResultText(result.result))
    );
    console.info("[feishu-adapter] sent task result text", {
      messageId: sent.data?.message_id ?? null,
      taskId: result.result.taskId
    });
  }

  public async handleCardActionEvent(event: {
    approvalId: string;
    chatId: string;
    decision: "allow" | "deny";
    openId: string | null;
    taskId: string;
  }): Promise<void> {
    if (this.runtimeApi === null) {
      return;
    }
    await this.runtimeApi.resolveApproval({
      adapterId: this.descriptor.adapterId,
      approvalId: event.approvalId,
      decision: event.decision,
      reviewerExternalUserId: event.openId,
      reviewerRuntimeUserId:
        event.openId === null
          ? `${this.descriptor.adapterId}:session:${event.chatId}`
          : `${this.descriptor.adapterId}:${event.openId}`
    });
  }

  public async sendCapabilityNotice(taskId: string, notice: GatewayCapabilityNotice): Promise<void> {
    const bound = this.taskMessageIds.get(taskId);
    if (bound === undefined || this.client === null) {
      return;
    }
    await this.client.im.message.patch({
      data: {
        content: renderTaskProgressCard(taskId, `${notice.capability}: ${notice.message}`)
      },
      path: {
        message_id: bound.messageId
      }
    });
  }

  public async sendEvent(event: GatewayTaskEvent): Promise<void> {
    if (event.kind !== "progress" || this.client === null) {
      return;
    }
    const bound = this.taskMessageIds.get(event.taskId);
    if (bound === undefined) {
      return;
    }
    await this.client.im.message.patch({
      data: {
        content: renderTaskProgressCard(event.taskId, event.detail)
      },
      path: {
        message_id: bound.messageId
      }
    });
  }

  public async sendResult(result: GatewayTaskLaunchResult): Promise<void> {
    const bound = this.taskMessageIds.get(result.result.taskId);
    if (bound === undefined || this.client === null) {
      return;
    }
    await this.client.im.message.patch({
      data: {
        content: renderTaskResultCard(result.result.output)
      },
      path: {
        message_id: bound.messageId
      }
    });

    if (result.result.status === "waiting_approval") {
      const approvalId = result.result.errorCode ?? result.result.taskId;
      await this.client.im.message.create(
        createInteractiveMessagePayload(bound.chatId, renderApprovalCard(result.result.taskId, approvalId))
      );
    }
  }
}

function createInteractiveMessagePayload(chatId: string, content: string): FeishuCreateMessagePayload {
  return {
    data: {
      content,
      msg_type: "interactive",
      receive_id: chatId
    },
    params: {
      receive_id_type: "chat_id"
    }
  };
}

function createTextMessagePayload(chatId: string, text: string): FeishuCreateMessagePayload {
  return {
    data: {
      content: JSON.stringify({ text: text.slice(0, 4000) }),
      msg_type: "text",
      receive_id: chatId
    },
    params: {
      receive_id_type: "chat_id"
    }
  };
}

function formatTaskResultText(result: GatewayTaskResultView): string {
  if (result.output !== null && result.output.trim().length > 0) {
    return result.output;
  }
  if (result.errorMessage !== null && result.errorMessage.trim().length > 0) {
    return `Execution failed: ${result.errorMessage}`;
  }
  if (result.status === "waiting_approval") {
    return "Approval is required before continuing.";
  }
  return "No output.";
}

async function createDefaultClients(config: FeishuGatewayConfig): Promise<{
  client: FeishuClientLike;
  createEventDispatcher: () => FeishuEventDispatcherLike;
  wsClient: FeishuWsClientLike;
}> {
  const lark = await import("@larksuiteoapi/node-sdk");
  const domain = config.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
  const loggerLevel =
    process.env.AUTO_TALON_FEISHU_DEBUG === "1" ? lark.LoggerLevel.debug : lark.LoggerLevel.info;
  const client = new lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    domain,
    loggerLevel
  }) as unknown as FeishuClientLike;
  const wsClient = new lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    domain,
    loggerLevel
  }) as unknown as FeishuWsClientLike;
  const createEventDispatcher = () =>
    new lark.EventDispatcher({ loggerLevel }) as unknown as FeishuEventDispatcherLike;
  return { client, createEventDispatcher, wsClient };
}

function parseMessageEvent(payload: unknown): {
  chatId: string;
  eventId: string | null;
  messageId: string | null;
  openId: string | null;
  text: string;
} | null {
  const event = getEventBody(payload);
  if (event === null) {
    return null;
  }
  const message = getRecord(event, "message");
  const sender = getRecord(event, "sender");
  const senderId = sender === null ? null : getRecord(sender, "sender_id");
  const chatId = readString(message, "chat_id");
  const text = readMessageText(message);
  if (chatId === null || text === null) {
    return null;
  }
  return {
    chatId,
    eventId: readString(event, "event_id"),
    messageId: readString(message, "message_id"),
    openId: readString(senderId, "open_id"),
    text
  };
}

function parseCardActionEvent(payload: unknown): {
  approvalId: string;
  chatId: string;
  decision: "allow" | "deny";
  openId: string | null;
  taskId: string;
} {
  const event = getEventBody(payload);
  const context = getRecord(event, "context");
  const openMessageId = readString(context, "open_message_id") ?? readString(event, "open_message_id") ?? "";
  const action = getRecord(event, "action");
  const value = getRecord(action, "value") ?? action ?? getRecord(event, "value");
  const approvalId = readString(value, "approvalId") ?? "";
  const decisionRaw = readString(value, "decision");
  const taskId = readString(value, "taskId") ?? "";
  const operator = getRecord(event, "operator");
  const operatorId = operator === null ? null : getRecord(operator, "operator_id");
  const openId = readString(operatorId, "open_id") ?? readString(event, "open_id");

  return {
    approvalId,
    chatId: readString(context, "open_chat_id") ?? readString(event, "open_chat_id") ?? openMessageId,
    decision: decisionRaw === "deny" ? "deny" : "allow",
    openId,
    taskId
  };
}

function readMessageText(message: Record<string, unknown> | null): string | null {
  if (message === null) {
    return null;
  }
  const content = readString(message, "content");
  if (content === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(content) as unknown;
    const text = readString(getRecord(parsed), "text");
    return text ?? content;
  } catch {
    return content;
  }
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  if (record === null) {
    return null;
  }
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function getRecord(input: unknown, key?: string): Record<string, unknown> | null {
  const target = key === undefined ? input : (input as Record<string, unknown> | null)?.[key];
  return typeof target === "object" && target !== null ? (target as Record<string, unknown>) : null;
}

function getEventBody(payload: unknown): Record<string, unknown> | null {
  const record = getRecord(payload);
  if (record === null) {
    return null;
  }
  return getRecord(record, "event") ?? record;
}

function summarizeMessagePayload(payload: unknown): Record<string, unknown> {
  const record = getRecord(payload);
  const event = getEventBody(payload);
  const message = getRecord(event, "message");
  const sender = getRecord(event, "sender");
  return {
    eventId: readString(event, "event_id"),
    eventKeys: event === null ? [] : Object.keys(event).sort(),
    hasEventEnvelope: record !== null && getRecord(record, "event") !== null,
    messageId: readString(message, "message_id"),
    messageType: readString(message, "message_type"),
    payloadKeys: record === null ? [] : Object.keys(record).sort(),
    senderType: readString(sender, "sender_type")
  };
}
