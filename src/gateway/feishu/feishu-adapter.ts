import type {
  AdapterDescriptor,
  GatewayCapabilityNotice,
  GatewayRuntimeApi,
  GatewayTaskEvent,
  GatewayTaskLaunchResult,
  InboundMessageAdapter,
  OutboundResponseAdapter
} from "../../types";
import {
  renderApprovalCard,
  renderTaskAcceptedCard,
  renderTaskProgressCard,
  renderTaskResultCard
} from "./feishu-card";
import type { FeishuGatewayConfig } from "./feishu-config";

interface FeishuClientLike {
  im: {
    message: {
      create: (payload: Record<string, unknown>) => Promise<{ data?: { message_id?: string } }>;
      patch: (payload: Record<string, unknown>) => Promise<unknown>;
    };
  };
}

interface FeishuWsClientLike {
  start: (options: Record<string, unknown>) => Promise<void> | void;
  stop?: () => void;
}

export interface FeishuAdapterOptions {
  adapterId?: string;
  createClients?: (config: FeishuGatewayConfig) => Promise<{
    client: FeishuClientLike;
    wsClient: FeishuWsClientLike;
  }>;
}

export class FeishuAdapter implements InboundMessageAdapter, OutboundResponseAdapter {
  public readonly descriptor: AdapterDescriptor;

  private runtimeApi: GatewayRuntimeApi | null = null;
  private client: FeishuClientLike | null = null;
  private wsClient: FeishuWsClientLike | null = null;
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
    await this.wsClient.start({
      eventDispatcher: {
        register: () => undefined
      }
    });
  }

  public stop(): Promise<void> {
    this.wsClient?.stop?.();
    this.wsClient = null;
    this.client = null;
    this.runtimeApi = null;
    return Promise.resolve();
  }

  public async handleMessageEvent(event: {
    chatId: string;
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

    const sent = await this.client.im.message.create({
      content: renderTaskAcceptedCard(result.result.taskId, trimmed),
      msg_type: "interactive",
      receive_id: event.chatId,
      receive_id_type: "chat_id"
    });
    if (sent.data?.message_id !== undefined) {
      this.taskMessageIds.set(result.result.taskId, {
        chatId: event.chatId,
        messageId: sent.data.message_id
      });
    }
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
      content: renderTaskProgressCard(taskId, `${notice.capability}: ${notice.message}`),
      message_id: bound.messageId
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
      content: renderTaskProgressCard(event.taskId, event.detail),
      message_id: bound.messageId
    });
  }

  public async sendResult(result: GatewayTaskLaunchResult): Promise<void> {
    const bound = this.taskMessageIds.get(result.result.taskId);
    if (bound === undefined || this.client === null) {
      return;
    }
    await this.client.im.message.patch({
      content: renderTaskResultCard(result.result.taskId, result.result.status, result.result.output),
      message_id: bound.messageId
    });

    if (result.result.status === "waiting_approval") {
      const approvalId = result.result.errorCode ?? result.result.taskId;
      await this.client.im.message.create({
        content: renderApprovalCard(result.result.taskId, approvalId),
        msg_type: "interactive",
        receive_id: bound.chatId,
        receive_id_type: "chat_id"
      });
    }
  }
}

async function createDefaultClients(config: FeishuGatewayConfig): Promise<{
  client: FeishuClientLike;
  wsClient: FeishuWsClientLike;
}> {
  const lark = await import("@larksuiteoapi/node-sdk");
  const domain = config.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
  const client = new lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    domain
  }) as unknown as FeishuClientLike;
  const wsClient = new lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    domain
  }) as unknown as FeishuWsClientLike;
  return { client, wsClient };
}
