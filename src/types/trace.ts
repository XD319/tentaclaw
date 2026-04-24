import type { JsonObject } from "./common.js";
import type { RuntimeErrorCode } from "./error.js";
import type { PathScope, PrivacyLevel, ToolCapability, ToolRiskLevel } from "./governance.js";
import type { MemoryScope, MemoryStatus, MemorySourceType } from "./memory.js";
import type {
  ExperiencePromotionTarget,
  ExperienceSourceType,
  ExperienceStatus,
  ExperienceType
} from "./experience.js";
import type { PolicyEffect } from "./policy.js";
import type { ApprovalStatus } from "./approval.js";
import type { ProviderErrorCategory } from "./runtime.js";
import type { ContextAssemblyDebugView } from "./context.js";
import type { RouteKind, RoutingMode } from "./budget.js";
import type { ToolExposureDecision } from "./tool-exposure.js";

export const TRACE_EVENT_TYPES = [
  "gateway_request_received",
  "gateway_capability_degraded",
  "gateway_rate_limited",
  "gateway_denied",
  "gateway_auth_failed",
  "gateway_approval_resolved",
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
  "tool_exposure_decided",
  "loop_iteration_completed",
  "turn_end",
  "retry",
  "interrupt",
  "final_outcome",
  "task_success",
  "task_failure",
  "review_resolved",
  "pre_compress",
  "session_end",
  "delegation_complete",
  "context_assembled",
  "repo_map_created",
  "memory_recalled",
  "recall_explain",
  "memory_written",
  "session_compacted",
  "thread_snapshot_created",
  "schedule_created",
  "schedule_paused",
  "schedule_resumed",
  "schedule_run_enqueued",
  "schedule_run_started",
  "schedule_run_finished",
  "schedule_run_failed",
  "schedule_run_retry_scheduled",
  "memory_snapshot_created",
  "experience_captured",
  "experience_reviewed",
  "experience_promoted",
  "skill_promotion_suggested",
  "route_decision",
  "budget_warning",
  "budget_exceeded",
  "cost_report",
  "experience_recall_ranked",
  "reviewer_trace",
  "inbox_item_created",
  "inbox_item_done",
  "commitment_created",
  "commitment_updated",
  "commitment_blocked",
  "commitment_unblocked",
  "commitment_completed",
  "commitment_cancelled",
  "next_action_created",
  "next_action_updated",
  "next_action_blocked",
  "next_action_done"
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
  previousTaskId?: string | null;
  runtimeUserId: string;
}

export interface GatewayCapabilityDegradedPayload extends JsonObject {
  adapterId: string;
  capability: string;
  fallbackBehavior: string;
  message: string;
}

export interface GatewayGuardPayload extends JsonObject {
  adapterId: string;
  externalSessionId: string;
  externalUserId: string | null;
  message: string;
}

export interface GatewayApprovalResolvedPayload extends JsonObject {
  adapterId: string;
  approvalId: string;
  decision: "allow" | "deny";
  reviewerExternalUserId: string | null;
  reviewerRuntimeUserId: string;
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
  sandboxKind: "file" | "network" | "shell" | "mcp";
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

export interface ToolExposureDecidedPayload extends JsonObject {
  iteration: number;
  taskId: string;
  exposedTools: string[];
  hiddenTools: string[];
  reasons: string[];
  decisions: ToolExposureDecision[];
}

export interface LoopIterationCompletedPayload extends JsonObject {
  iteration: number;
  toolCallCount: number;
}

export interface TurnEndPayload extends JsonObject {
  iteration: number;
  taskStatus: string;
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

export interface TaskSuccessPayload extends JsonObject {
  cwd: string;
  outputSummary: string;
  status: "succeeded";
}

export interface TaskFailurePayload extends JsonObject {
  cwd: string;
  errorCode: RuntimeErrorCode;
  errorMessage: string;
  status: "failed" | "cancelled";
}

export interface ReviewResolvedPayload extends JsonObject {
  approvalId: string;
  reviewerId: string | null;
  status: ApprovalStatus;
  toolCallId: string;
  toolName: string;
}

export interface PreCompressPayload extends JsonObject {
  messageCount: number;
  reason: "message_count" | "context_budget";
}

export interface SessionEndPayload extends JsonObject {
  status: "succeeded" | "failed" | "cancelled";
  summary: string;
}

export interface DelegationCompletePayload extends JsonObject {
  delegateId: string;
  status: string;
  summary: string;
}

export interface ContextAssembledPayload extends JsonObject {
  iteration: number;
  debugView: ContextAssemblyDebugView;
}

export interface RepoMapCreatedPayload extends JsonObject {
  importantFiles: string[];
  languages: string[];
  packageManager: string | null;
  scripts: JsonObject;
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

export interface RecallExplainPayload extends JsonObject {
  enrichedQuery: string;
  tokenBudget: number;
  tokenUsed: number;
  candidateCount: number;
  selectedCount: number;
  skippedCount: number;
  items: Array<{
    id: string;
    scope: MemoryScope;
    score: number;
    tokenEstimate: number;
    reason: string;
    selected: boolean;
  } & JsonObject>;
}

export interface MemoryWrittenPayload extends JsonObject {
  memoryId: string;
  scope: MemoryScope;
  sourceType: MemorySourceType;
  privacyLevel: PrivacyLevel;
  status: MemoryStatus;
}

export interface SessionCompactedPayload extends JsonObject {
  reason: "message_count" | "context_budget" | "token_budget" | "tool_call_count";
  summaryMemoryId: string;
  replacedMessageCount: number;
  summarizerId?: string;
}

export interface ThreadSnapshotCreatedPayload extends JsonObject {
  snapshotId: string;
  threadId: string;
  trigger: "compact" | "manual" | "resume";
  goal: string;
}

export interface ScheduleCreatedPayload extends JsonObject {
  scheduleId: string;
  status: "active" | "paused";
  nextFireAt: string | null;
}

export interface SchedulePausedPayload extends JsonObject {
  scheduleId: string;
  status: "paused";
}

export interface ScheduleResumedPayload extends JsonObject {
  scheduleId: string;
  status: "active";
  nextFireAt: string | null;
}

export interface ScheduleRunEnqueuedPayload extends JsonObject {
  runId: string;
  scheduleId: string;
  trigger: "scheduled" | "manual" | "retry";
  attemptNumber: number;
  scheduledAt: string;
}

export interface ScheduleRunStartedPayload extends JsonObject {
  runId: string;
  scheduleId: string;
  attemptNumber: number;
}

export interface ScheduleRunFinishedPayload extends JsonObject {
  runId: string;
  scheduleId: string;
  attemptNumber: number;
  status: "completed" | "waiting_approval" | "blocked" | "cancelled";
  taskId: string | null;
  threadId: string | null;
}

export interface ScheduleRunFailedPayload extends JsonObject {
  runId: string;
  scheduleId: string;
  attemptNumber: number;
  errorCode: RuntimeErrorCode | null;
  errorMessage: string | null;
  taskId: string | null;
}

export interface ScheduleRunRetryScheduledPayload extends JsonObject {
  priorRunId: string;
  retryRunId: string;
  scheduleId: string;
  nextAttemptNumber: number;
  retryAt: string;
  delayMs: number;
}

export interface MemorySnapshotCreatedPayload extends JsonObject {
  snapshotId: string;
  scope: MemoryScope;
  scopeKey: string;
  memoryCount: number;
}

export interface ExperienceCapturedPayload extends JsonObject {
  experienceId: string;
  type: ExperienceType;
  sourceType: ExperienceSourceType;
  status: ExperienceStatus;
  valueScore: number;
}

export interface ExperienceReviewedPayload extends JsonObject {
  experienceId: string;
  reviewerId: string;
  status: ExperienceStatus;
  valueScore: number;
}

export interface ExperiencePromotedPayload extends JsonObject {
  experienceId: string;
  target: ExperiencePromotionTarget;
  promotedMemoryId: string | null;
}

export interface SkillPromotionSuggestedPayload extends JsonObject {
  draftId: string;
  targetSkillId: string;
  version: string;
  previousVersion: string | null;
  sourceExperienceIds: string[];
  successCount: number;
  successRate: number;
  stability: number;
  riskLevel: "low" | "medium" | "high";
  humanJudgmentWeight: number;
  reasons: string[];
}

export interface RouteDecisionPayload extends JsonObject {
  taskId: string;
  threadId: string | null;
  mode: RoutingMode;
  kind: RouteKind;
  tier: "cheap" | "balanced" | "quality" | null;
  providerName: string | null;
  reason: string;
}

export interface BudgetWarningPayload extends JsonObject {
  taskId: string;
  threadId: string | null;
  scope: "task" | "thread";
  mode: RoutingMode;
  usedInput: number;
  usedOutput: number;
  usedCostUsd: number;
  breachedLimit: "input" | "output" | "cost" | null;
  reasons: string[];
}

export interface BudgetExceededPayload extends JsonObject {
  taskId: string;
  threadId: string | null;
  scope: "task" | "thread";
  mode: RoutingMode;
  usedInput: number;
  usedOutput: number;
  usedCostUsd: number;
  breachedLimit: "input" | "output" | "cost" | null;
  reasons: string[];
}

export interface CostReportPayload extends JsonObject {
  taskId: string;
  threadId: string | null;
  providerName: string;
  mode: RoutingMode;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number | null;
}

export interface ExperienceRecallRankedPayload extends JsonObject {
  query: string;
  selectedExperienceIds: string[];
  entries: Array<{
    experienceId: string;
    title: string;
    finalScore: number;
    explanation: string;
    downrankReasons: string[];
    status: ExperienceStatus;
    type: ExperienceType;
    valueScore: number;
  }>;
}

export interface ReviewerTracePayload extends JsonObject {
  iteration: number;
  reviewerSeenSummary: string;
  reviewerJudgementSummary: string;
  riskDetected: boolean;
  continuationBlocked: boolean;
  blockingReason: string | null;
}

export interface InboxItemCreatedPayload extends JsonObject {
  inboxId: string;
  userId: string;
  category: string;
  status: string;
  taskId: string | null;
}

export interface InboxItemDonePayload extends JsonObject {
  inboxId: string;
  userId: string;
  status: string;
  reviewerId: string;
}

export interface CommitmentCreatedPayload extends JsonObject {
  commitmentId: string;
  threadId: string;
  taskId: string | null;
  status: string;
  title: string;
}

export interface CommitmentUpdatedPayload extends JsonObject {
  commitmentId: string;
  threadId: string;
  taskId: string | null;
  status: string;
  blockedReason: string | null;
  pendingDecision: string | null;
}

export interface CommitmentBlockedPayload extends JsonObject {
  commitmentId: string;
  threadId: string;
  taskId: string | null;
  blockedReason: string;
}

export interface CommitmentUnblockedPayload extends JsonObject {
  commitmentId: string;
  threadId: string;
  taskId: string | null;
}

export interface CommitmentCompletedPayload extends JsonObject {
  commitmentId: string;
  threadId: string;
  taskId: string | null;
}

export interface CommitmentCancelledPayload extends JsonObject {
  commitmentId: string;
  threadId: string;
  taskId: string | null;
}

export interface NextActionCreatedPayload extends JsonObject {
  nextActionId: string;
  commitmentId: string | null;
  threadId: string;
  taskId: string | null;
  status: string;
  title: string;
}

export interface NextActionUpdatedPayload extends JsonObject {
  nextActionId: string;
  commitmentId: string | null;
  threadId: string;
  taskId: string | null;
  status: string;
  blockedReason: string | null;
}

export interface NextActionBlockedPayload extends JsonObject {
  nextActionId: string;
  commitmentId: string | null;
  threadId: string;
  taskId: string | null;
  blockedReason: string;
}

export interface NextActionDonePayload extends JsonObject {
  nextActionId: string;
  commitmentId: string | null;
  threadId: string;
  taskId: string | null;
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
  | TraceEventBase<"gateway_rate_limited", GatewayGuardPayload>
  | TraceEventBase<"gateway_denied", GatewayGuardPayload>
  | TraceEventBase<"gateway_auth_failed", GatewayGuardPayload>
  | TraceEventBase<"gateway_approval_resolved", GatewayApprovalResolvedPayload>
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
  | TraceEventBase<"tool_exposure_decided", ToolExposureDecidedPayload>
  | TraceEventBase<"loop_iteration_completed", LoopIterationCompletedPayload>
  | TraceEventBase<"turn_end", TurnEndPayload>
  | TraceEventBase<"retry", RetryPayload>
  | TraceEventBase<"interrupt", InterruptPayload>
  | TraceEventBase<"final_outcome", FinalOutcomePayload>
  | TraceEventBase<"task_success", TaskSuccessPayload>
  | TraceEventBase<"task_failure", TaskFailurePayload>
  | TraceEventBase<"review_resolved", ReviewResolvedPayload>
  | TraceEventBase<"pre_compress", PreCompressPayload>
  | TraceEventBase<"session_end", SessionEndPayload>
  | TraceEventBase<"delegation_complete", DelegationCompletePayload>
  | TraceEventBase<"context_assembled", ContextAssembledPayload>
  | TraceEventBase<"repo_map_created", RepoMapCreatedPayload>
  | TraceEventBase<"memory_recalled", MemoryRecalledPayload>
  | TraceEventBase<"recall_explain", RecallExplainPayload>
  | TraceEventBase<"memory_written", MemoryWrittenPayload>
  | TraceEventBase<"session_compacted", SessionCompactedPayload>
  | TraceEventBase<"thread_snapshot_created", ThreadSnapshotCreatedPayload>
  | TraceEventBase<"schedule_created", ScheduleCreatedPayload>
  | TraceEventBase<"schedule_paused", SchedulePausedPayload>
  | TraceEventBase<"schedule_resumed", ScheduleResumedPayload>
  | TraceEventBase<"schedule_run_enqueued", ScheduleRunEnqueuedPayload>
  | TraceEventBase<"schedule_run_started", ScheduleRunStartedPayload>
  | TraceEventBase<"schedule_run_finished", ScheduleRunFinishedPayload>
  | TraceEventBase<"schedule_run_failed", ScheduleRunFailedPayload>
  | TraceEventBase<"schedule_run_retry_scheduled", ScheduleRunRetryScheduledPayload>
  | TraceEventBase<"memory_snapshot_created", MemorySnapshotCreatedPayload>
  | TraceEventBase<"experience_captured", ExperienceCapturedPayload>
  | TraceEventBase<"experience_reviewed", ExperienceReviewedPayload>
  | TraceEventBase<"experience_promoted", ExperiencePromotedPayload>
  | TraceEventBase<"skill_promotion_suggested", SkillPromotionSuggestedPayload>
  | TraceEventBase<"route_decision", RouteDecisionPayload>
  | TraceEventBase<"budget_warning", BudgetWarningPayload>
  | TraceEventBase<"budget_exceeded", BudgetExceededPayload>
  | TraceEventBase<"cost_report", CostReportPayload>
  | TraceEventBase<"experience_recall_ranked", ExperienceRecallRankedPayload>
  | TraceEventBase<"reviewer_trace", ReviewerTracePayload>
  | TraceEventBase<"inbox_item_created", InboxItemCreatedPayload>
  | TraceEventBase<"inbox_item_done", InboxItemDonePayload>
  | TraceEventBase<"commitment_created", CommitmentCreatedPayload>
  | TraceEventBase<"commitment_updated", CommitmentUpdatedPayload>
  | TraceEventBase<"commitment_blocked", CommitmentBlockedPayload>
  | TraceEventBase<"commitment_unblocked", CommitmentUnblockedPayload>
  | TraceEventBase<"commitment_completed", CommitmentCompletedPayload>
  | TraceEventBase<"commitment_cancelled", CommitmentCancelledPayload>
  | TraceEventBase<"next_action_created", NextActionCreatedPayload>
  | TraceEventBase<"next_action_updated", NextActionUpdatedPayload>
  | TraceEventBase<"next_action_blocked", NextActionBlockedPayload>
  | TraceEventBase<"next_action_done", NextActionDonePayload>;

export type TraceEventDraft = Omit<TraceEvent, "eventId" | "sequence" | "timestamp"> &
  Partial<Pick<TraceEvent, "eventId" | "sequence" | "timestamp">>;
