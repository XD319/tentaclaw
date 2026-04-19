import type { JsonObject } from "./common";
import type { RuntimeErrorCode } from "./error";
import type { PathScope, PrivacyLevel, ToolCapability, ToolRiskLevel } from "./governance";
import type { MemoryScope, MemoryStatus, MemorySourceType } from "./memory";
import type { PolicyEffect } from "./policy";
import type { ApprovalStatus } from "./approval";
import type { ProviderErrorCategory } from "./runtime";
import type { ContextAssemblyDebugView } from "./context";

export const TRACE_EVENT_TYPES = [
  "gateway_request_received",
  "gateway_capability_degraded",
  "task_created",
  "task_started",
  "model_request",
  "model_response",
  "provider_request_started",
  "provider_request_succeeded",
  "provider_request_failed",
  "policy_decision",
  "approval_requested",
  "approval_resolved",
  "file_rollback",
  "sandbox_enforced",
  "tool_call_requested",
  "tool_call_started",
  "tool_call_finished",
  "tool_call_failed",
  "loop_iteration_completed",
  "retry",
  "interrupt",
  "final_outcome",
  "context_assembled",
  "memory_recalled",
  "memory_written",
  "session_compacted",
  "memory_snapshot_created",
  "reviewer_trace"
] as const;

export type TraceEventType = (typeof TRACE_EVENT_TYPES)[number];

export const TRACE_STAGES = [
  "gateway",
  "lifecycle",
  "planning",
  "governance",
  "tooling",
  "control",
  "completion",
  "memory"
] as const;

export type TraceStage = (typeof TRACE_STAGES)[number];

export interface TraceEventBase<
  TType extends TraceEventType = TraceEventType,
  TPayload extends JsonObject = JsonObject
> {
  eventId: string;
  taskId: string;
  sequence: number;
  timestamp: string;
  eventType: TType;
  stage: TraceStage;
  actor: string;
  summary: string;
  payload: TPayload;
}

export interface TaskCreatedPayload extends JsonObject {
  cwd: string;
  input: string;
  providerName: string;
  agentProfileId: string;
  requesterUserId: string;
}

export interface GatewayRequestReceivedPayload extends JsonObject {
  adapterId: string;
  adapterKind: string;
  externalSessionId: string;
  externalUserId: string | null;
  runtimeUserId: string;
}

export interface GatewayCapabilityDegradedPayload extends JsonObject {
  adapterId: string;
  capability: string;
  fallbackBehavior: string;
  message: string;
}

export interface TaskStartedPayload extends JsonObject {
  maxIterations: number;
  timeoutMs: number;
}

export interface ModelRequestPayload extends JsonObject {
  iteration: number;
  inputMessageCount: number;
  availableTools: string[];
  agentProfileId: string;
  tokenBudget: JsonObject;
}

export interface ModelResponsePayload extends JsonObject {
  iteration: number;
  kind: "final" | "retry" | "tool_calls";
  message: string;
  toolNames: string[];
}

export interface ProviderRequestStartedPayload extends JsonObject {
  iteration: number;
  inputMessageCount: number;
  modelName: string | null;
  providerName: string;
}

export interface ProviderRequestSucceededPayload extends JsonObject {
  iteration: number;
  kind: "final" | "retry" | "tool_calls";
  latencyMs: number;
  modelName: string | null;
  providerName: string;
  retryCount: number;
  usage: JsonObject | null;
}

export interface ProviderRequestFailedPayload extends JsonObject {
  errorCategory: ProviderErrorCategory;
  iteration: number;
  latencyMs: number;
  modelName: string | null;
  providerName: string;
  retryCount: number;
}

export interface PolicyDecisionPayload extends JsonObject {
  decisionId: string;
  effect: PolicyEffect;
  matchedRuleId: string | null;
  toolCallId: string;
  toolName: string;
  capability: ToolCapability;
  pathScope: PathScope;
  privacyLevel: PrivacyLevel;
  riskLevel: ToolRiskLevel;
}

export interface ApprovalRequestedPayload extends JsonObject {
  approvalId: string;
  expiresAt: string;
  toolCallId: string;
  toolName: string;
}

export interface ApprovalResolvedPayload extends JsonObject {
  approvalId: string;
  reviewerId: string | null;
  status: ApprovalStatus;
  toolCallId: string;
  toolName: string;
}

export interface SandboxEnforcedPayload extends JsonObject {
  toolCallId: string;
  toolName: string;
  sandboxKind: "file" | "network" | "shell";
  status: "allowed" | "denied";
  target: string;
}

export interface ToolCallRequestedPayload extends JsonObject {
  iteration: number;
  toolCallId: string;
  toolName: string;
  riskLevel: ToolRiskLevel;
  reason: string;
  input: JsonObject;
}

export interface ToolCallStartedPayload extends JsonObject {
  iteration: number;
  toolCallId: string;
  toolName: string;
}

export interface ToolCallFinishedPayload extends JsonObject {
  iteration: number;
  toolCallId: string;
  toolName: string;
  summary: string;
  outputPreview: string;
}

export interface ToolCallFailedPayload extends JsonObject {
  iteration: number;
  toolCallId: string;
  toolName: string;
  errorCode: RuntimeErrorCode;
  errorMessage: string;
}

export interface LoopIterationCompletedPayload extends JsonObject {
  iteration: number;
  toolCallCount: number;
}

export interface RetryPayload extends JsonObject {
  iteration: number;
  reason: string;
  delayMs: number;
}

export interface InterruptPayload extends JsonObject {
  iteration: number;
  reason: string;
}

export interface FinalOutcomePayload extends JsonObject {
  status: "succeeded" | "failed" | "cancelled";
  output: string | null;
  errorCode: RuntimeErrorCode | null;
  errorMessage: string | null;
}

export interface ContextAssembledPayload extends JsonObject {
  iteration: number;
  debugView: ContextAssemblyDebugView;
}

export interface MemoryRecalledPayload extends JsonObject {
  query: string;
  selectedMemoryIds: string[];
  selectedScopes: MemoryScope[];
  blockedMemoryIds: string[];
  entries: Array<{
    memoryId: string;
    title: string;
    explanation: string;
    confidence: number;
    status: MemoryStatus;
    selected: boolean;
    blocked: boolean;
    sourceType: MemorySourceType;
    privacyLevel: PrivacyLevel;
    retentionPolicyKind: string;
    downrankReasons: string[];
    filterReasonCode: string | null;
    filterReason: string | null;
  }>;
}

export interface MemoryWrittenPayload extends JsonObject {
  memoryId: string;
  scope: MemoryScope;
  sourceType: MemorySourceType;
  privacyLevel: PrivacyLevel;
  status: MemoryStatus;
}

export interface SessionCompactedPayload extends JsonObject {
  reason: "message_count" | "context_budget";
  summaryMemoryId: string;
  replacedMessageCount: number;
}

export interface MemorySnapshotCreatedPayload extends JsonObject {
  snapshotId: string;
  scope: MemoryScope;
  scopeKey: string;
  memoryCount: number;
}

export interface ReviewerTracePayload extends JsonObject {
  iteration: number;
  reviewerSeenSummary: string;
  reviewerJudgementSummary: string;
  riskDetected: boolean;
  continuationBlocked: boolean;
  blockingReason: string | null;
}

export interface FileRollbackPayload extends JsonObject {
  artifactId: string;
  operation: string;
  originalExists: boolean;
  path: string;
  restoredHash: string | null;
}

export type TraceEvent =
  | TraceEventBase<"gateway_request_received", GatewayRequestReceivedPayload>
  | TraceEventBase<"gateway_capability_degraded", GatewayCapabilityDegradedPayload>
  | TraceEventBase<"task_created", TaskCreatedPayload>
  | TraceEventBase<"task_started", TaskStartedPayload>
  | TraceEventBase<"model_request", ModelRequestPayload>
  | TraceEventBase<"model_response", ModelResponsePayload>
  | TraceEventBase<"provider_request_started", ProviderRequestStartedPayload>
  | TraceEventBase<"provider_request_succeeded", ProviderRequestSucceededPayload>
  | TraceEventBase<"provider_request_failed", ProviderRequestFailedPayload>
  | TraceEventBase<"policy_decision", PolicyDecisionPayload>
  | TraceEventBase<"approval_requested", ApprovalRequestedPayload>
  | TraceEventBase<"approval_resolved", ApprovalResolvedPayload>
  | TraceEventBase<"file_rollback", FileRollbackPayload>
  | TraceEventBase<"sandbox_enforced", SandboxEnforcedPayload>
  | TraceEventBase<"tool_call_requested", ToolCallRequestedPayload>
  | TraceEventBase<"tool_call_started", ToolCallStartedPayload>
  | TraceEventBase<"tool_call_finished", ToolCallFinishedPayload>
  | TraceEventBase<"tool_call_failed", ToolCallFailedPayload>
  | TraceEventBase<"loop_iteration_completed", LoopIterationCompletedPayload>
  | TraceEventBase<"retry", RetryPayload>
  | TraceEventBase<"interrupt", InterruptPayload>
  | TraceEventBase<"final_outcome", FinalOutcomePayload>
  | TraceEventBase<"context_assembled", ContextAssembledPayload>
  | TraceEventBase<"memory_recalled", MemoryRecalledPayload>
  | TraceEventBase<"memory_written", MemoryWrittenPayload>
  | TraceEventBase<"session_compacted", SessionCompactedPayload>
  | TraceEventBase<"memory_snapshot_created", MemorySnapshotCreatedPayload>
  | TraceEventBase<"reviewer_trace", ReviewerTracePayload>;

export type TraceEventDraft = Omit<TraceEvent, "eventId" | "sequence" | "timestamp"> &
  Partial<Pick<TraceEvent, "eventId" | "sequence" | "timestamp">>;
