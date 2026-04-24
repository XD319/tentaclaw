import type { JsonObject } from "./common.js";
import type { AuditLogRecord } from "./audit.js";
import type { TraceEvent } from "./trace.js";
import type { InboxDeliveryEvent, InboxItem, InboxListQuery } from "./inbox.js";

export type AdapterCapabilityName =
  | "textInteraction"
  | "approvalInteraction"
  | "fileCapability"
  | "attachmentCapability"
  | "streamingCapability"
  | "structuredCardCapability";

export interface AdapterCapabilitySupport {
  supported: boolean;
  detail?: string;
}

export interface AdapterCapabilityDeclaration {
  approvalInteraction: AdapterCapabilitySupport;
  attachmentCapability: AdapterCapabilitySupport;
  fileCapability: AdapterCapabilitySupport;
  streamingCapability: AdapterCapabilitySupport;
  structuredCardCapability: AdapterCapabilitySupport;
  textInteraction: AdapterCapabilitySupport;
}

export type AdapterKind =
  | "cli"
  | "tui"
  | "webhook"
  | "sdk"
  | "slack"
  | "telegram"
  | "discord"
  | "mcp_client"
  | "mcp_server"
  | "remote_bridge"
  | "teammate";

export type AdapterLifecycleState = "created" | "starting" | "running" | "stopped";

export interface AdapterDescriptor {
  adapterId: string;
  description: string;
  displayName: string;
  kind: AdapterKind;
  lifecycleState: AdapterLifecycleState;
  capabilities: AdapterCapabilityDeclaration;
}

export interface GatewayRequesterIdentity {
  externalSessionId: string;
  externalUserId: string | null;
  externalUserLabel: string | null;
}

export interface GatewayIdentityBinding {
  adapterId: string;
  externalUserId: string | null;
  runtimeUserId: string;
}

export interface GatewaySessionBinding {
  adapterId: string;
  createdAt: string;
  externalSessionId: string;
  externalUserId: string | null;
  metadata: JsonObject;
  runtimeUserId: string;
  sessionBindingId: string;
  taskId: string;
  updatedAt: string;
}

export interface GatewayTaskRequest {
  agentProfileId?: "executor" | "planner" | "reviewer";
  continuation?: "new" | "resume-latest";
  cwd?: string;
  interactionRequirements?: Partial<Record<AdapterCapabilityName, "preferred" | "required">>;
  metadata?: JsonObject;
  requester: GatewayRequesterIdentity;
  taskInput: string;
  timeoutMs?: number;
}

export interface GatewayCapabilityNotice {
  capability: AdapterCapabilityName;
  fallbackBehavior: string;
  message: string;
  severity: "info" | "warning";
}

export type GatewayTaskEvent =
  | {
      kind: "trace";
      taskId: string;
      trace: TraceEvent;
    }
  | {
      kind: "audit";
      audit: AuditLogRecord;
      taskId: string;
    }
  | {
      kind: "progress";
      detail: string;
      taskId: string;
    }
  | {
      kind: "gateway_notice";
      notice: GatewayCapabilityNotice;
      taskId: string;
    };

export type GatewayInboxFilter = InboxListQuery;

export interface GatewayTaskResultView {
  errorCode: string | null;
  errorMessage: string | null;
  output: string | null;
  pendingApprovalId: string | null;
  status: string;
  taskId: string;
}

export interface GatewayTaskLaunchResult {
  adapter: AdapterDescriptor;
  notices: GatewayCapabilityNotice[];
  result: GatewayTaskResultView;
  sessionBinding: GatewaySessionBinding;
}

export interface GatewayTaskSnapshot {
  adapterSource: {
    adapterId: string;
    externalSessionId: string;
    externalUserId: string | null;
    runtimeUserId: string;
  } | null;
  audit: AuditLogRecord[];
  notices: GatewayCapabilityNotice[];
  task: GatewayTaskResultView;
  trace: TraceEvent[];
}

export interface GatewayRuntimeApi {
  getTaskSnapshot(taskId: string): GatewayTaskSnapshot | null;
  listInbox(filter?: GatewayInboxFilter): InboxItem[];
  markInboxDone(inboxId: string, reviewerRuntimeUserId: string): InboxItem;
  registerOutboundAdapter(adapterId: string, adapter: OutboundResponseAdapter): void;
  resolveApproval(params: {
    adapterId: string;
    approvalId: string;
    decision: "allow" | "deny";
    reviewerExternalUserId: string | null;
    reviewerRuntimeUserId: string;
  }): Promise<GatewayTaskLaunchResult | null>;
  submitTask(adapter: AdapterDescriptor, request: GatewayTaskRequest): Promise<GatewayTaskLaunchResult>;
  subscribeToCompletion(taskId: string, listener: (event: GatewayTaskEvent) => void): () => void;
  subscribeToInbox(filter: GatewayInboxFilter, listener: (event: InboxDeliveryEvent) => void): () => void;
  subscribeToTaskEvents(taskId: string, listener: (event: GatewayTaskEvent) => void): () => void;
}

export interface AdapterLifecycle {
  start(context: { runtimeApi: GatewayRuntimeApi }): Promise<void>;
  stop(): Promise<void>;
}

export interface InboundMessageAdapter extends AdapterLifecycle {
  descriptor: AdapterDescriptor;
}

export interface OutboundResponseAdapter {
  sendInboxEvent?(event: InboxDeliveryEvent): Promise<void>;
  sendCapabilityNotice?(taskId: string, notice: GatewayCapabilityNotice): Promise<void>;
  sendEvent?(event: GatewayTaskEvent): Promise<void>;
  sendResult?(result: GatewayTaskLaunchResult): Promise<void>;
}
