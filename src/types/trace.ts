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
  "provider_retry_scheduled",
  "provider_request_succeeded",
  "provider_request_failed",
  "iteration_budget_pressure",
  "iteration_exhausted",
  "completion_verification_missing",
  "completion_verification_satisfied",
  "completion_verification_pending",
  "environment_command_failed",
  "intent_fulfillment_missing",
  "empty_final_guarded",
  "unpolished_final_guarded",
  "invalid_final_output_rejected",
  "read_only_analysis_guard",
  "duplicate_tool_replayed",
  "no_tools_tool_calls_ignored",
  "policy_decision",
  "accept_edits_auto_allowed",
  "approval_requested",
  "approval_resolved",
  "clarify_requested",
  "clarify_resolved",
  "clarify_cancelled",
  "file_rollback",
  "sandbox_enforced",
  "tool_call_requested",
  "tool_call_started",
  "tool_call_finished",
  "tool_call_failed",
  "tool_call_blocked",
  "tool_exposure_decided",
  "runtime_tool_gate_applied",
  "loop_iteration_completed",
  "turn_end",
  "retry",
  "interrupt",
  "final_outcome",
  "task_success",
  "task_failure",
  "review_resolved",
  "pre_compress",
  "compact_evaluated",
  "manual_compact_triggered",
  "tail_budget_exceeded",
  "micro_compact_pruned",
  "compact_summarizer_failed",
  "session_end",
  "delegation_complete",
  "context_assembled",
  "recent_files_refetched",
  "recent_files_pinned",
  "memory_context_injected",
  "session_todos_injected",
  "prior_task_context_injected",
  "reactive_compact_triggered",
  "repo_map_created",
  "memory_recalled",
  "recall_explain",
  "memory_written",
  "memory_flush_completed",
  "memory_write_rejected",
  "session_compacted",
  "session_summary_written",
  "session_goal_updated",
  "user_messages_pinned",
  "constraint_captured",
  "feature_backlog_updated",
  "feature_backlog_filtered",
  "task_superseded",
  "schedule_created",
  "schedule_updated",
  "schedule_archived",
  "schedule_paused",
  "schedule_resumed",
  "schedule_run_enqueued",
  "schedule_run_skipped_overlap",
  "schedule_run_started",
  "schedule_run_finished",
  "schedule_run_failed",
  "schedule_run_retry_scheduled",
  "skill_context_loaded",
  "memory_snapshot_created",
  "experience_captured",
  "experience_reviewed",
  "experience_promoted",
  "skill_promotion_suggested",
  "route_decision",
  "model_selection_updated",
  "model_selection_cleared",
  "model_fallback_started",
  "model_fallback_succeeded",
  "model_fallback_exhausted",
  "credential_rotated",
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
  "next_action_done",
  "worker_dispatched",
  "worker_succeeded",
  "worker_failed",
  "worker_timeout",
  "worker_retried",
  "task_recovery_started",
  "tool_execution_failed"
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
  timeoutMode?: "activity" | "wall_clock";
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

export interface ProviderRetryScheduledPayload extends JsonObject {
  attempt: number;
  delayMs: number;
  errorCategory: ProviderErrorCategory;
  iteration: number;
  maxRetries: number;
  modelName: string | null;
  providerName: string;
}

export interface ProviderRequestFailedPayload extends JsonObject {
  errorCategory: ProviderErrorCategory;
  errorMessage?: string;
  iteration: number;
  lastActivityReason?: string | null;
  latencyMs: number;
  modelName: string | null;
  providerName: string;
  retryCount: number;
  timeoutMs?: number;
  timeoutSource?: "activity" | "provider" | "wall_clock";
}

export interface IterationBudgetPressurePayload extends JsonObject {
  iteration: number;
  maxIterations: number;
  remainingIterations: number;
  tier: "critical" | "warning";
}

export interface NoToolsToolCallsIgnoredPayload extends JsonObject {
  iteration: number;
  message: string;
  reason: string;
  toolNames: string[];
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

export interface AcceptEditsAutoAllowedPayload extends JsonObject {
  capability: ToolCapability;
  interactionMode: "acceptEdits";
  toolCallId: string;
  toolName: string;
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

export interface ClarifyRequestedPayload extends JsonObject {
  promptId: string;
  toolCallId: string;
  question: string;
}

export interface ClarifyResolvedPayload extends JsonObject {
  promptId: string;
  status: "answered" | "timed_out";
  answerOptionId?: string | null;
  answerText?: string | null;
  answers?: Record<string, string | string[]> | null;
  response?: string | null;
}

export interface ClarifyCancelledPayload extends JsonObject {
  promptId: string;
  reviewerId: string | null;
}

export interface SandboxEnforcedPayload extends JsonObject {
  toolCallId: string;
  toolName: string;
  sandboxKind: "file" | "network" | "shell" | "mcp" | "prompt";
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

export interface FileChangeTracePayload extends JsonObject {
  addedLineCount: number;
  changedLineCount: number;
  path: string;
  removedLineCount: number;
  unifiedDiffPreview: string;
}

export type TodoTraceStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoTraceItem extends JsonObject {
  content: string;
  id: string;
  status: TodoTraceStatus;
  statusUpdatedAt?: string;
}

export interface TodoTracePayload extends JsonObject {
  doneCount: number;
  todos: TodoTraceItem[];
  totalCount: number;
}

export interface ToolCallFinishedPayload extends JsonObject {
  fileChange?: FileChangeTracePayload;
  iteration: number;
  toolCallId: string;
  toolName: string;
  summary: string;
  outputPreview: string;
  todoSnapshot?: TodoTracePayload;
}

export interface ToolCallFailedPayload extends JsonObject {
  iteration: number;
  toolCallId: string;
  toolName: string;
  errorCode: RuntimeErrorCode;
  errorMessage: string;
}

export interface ToolCallBlockedPayload extends JsonObject {
  iteration: number;
  toolCallId: string;
  toolName: string;
  availableTools: string[];
  mode: "normal" | "write_required";
  reason: string;
  violationCount: number;
}

export interface ToolExposureDecidedPayload extends JsonObject {
  iteration: number;
  taskId: string;
  exposedTools: string[];
  hiddenTools: string[];
  reasons: string[];
  decisions: ToolExposureDecision[];
}

export interface RuntimeToolGateAppliedPayload extends JsonObject {
  iteration: number;
  mode: "write_required";
  visibleTools: string[];
  hiddenTools: string[];
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
  compactedCount?: number;
  debugView: ContextAssemblyDebugView;
  iteration: number;
  microPrunedCount?: number;
  promptTokenEstimate?: number;
}

export interface CompactEvaluatedPayload extends JsonObject {
  compactCooldownRemaining: number | null;
  maxMessagesBeforeCompact: number;
  messageCount: number;
  reason: string | null;
  tokenEstimate: number | null;
  tokenThreshold: number | null;
  toolCallCount: number | null;
  toolCallThreshold: number | null;
  triggered: boolean;
}

export interface ManualCompactTriggeredPayload extends JsonObject {
  focusTopic?: string;
  iteration: number;
}

export interface TailBudgetExceededPayload extends JsonObject {
  protectLastN: number;
  tailMessageCount: number;
  tailTokenBudget: number;
  usedTokens: number;
}

export interface MicroCompactPrunedPayload extends JsonObject {
  iteration: number;
  prunedCount: number;
  savedTokensEstimate: number;
}

export interface CompactSummarizerFailedPayload extends JsonObject {
  error: string;
  summarizer: string;
}

export interface RecentFilesRefetchedPayload extends JsonObject {
  evicted: string[];
  paths: string[];
}

export interface RecentFilesPinnedPayload extends JsonObject {
  entries: Array<{
    bytes: number;
    path: string;
    truncated: boolean;
  }>;
}

export interface MemoryContextInjectedPayload extends JsonObject {
  fragmentCount: number;
  iteration: number;
  tokenEstimate: number;
}

export interface SessionTodosInjectedPayload extends JsonObject {
  iteration?: number;
  todoCount: number;
}

export interface PriorTaskContextInjectedPayload extends JsonObject {
  priorTaskId: string;
  truncated: boolean;
}

export interface ReactiveCompactTriggeredPayload extends JsonObject {
  droppedMessageCount: number;
  iteration: number;
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

export interface MemoryFlushCompletedPayload extends JsonObject {
  iteration: number;
  suggestionCount: number;
}

export interface MemoryWrittenPayload extends JsonObject {
  memoryId: string;
  scope: MemoryScope;
  sourceType: MemorySourceType;
  privacyLevel: PrivacyLevel;
  status: MemoryStatus;
}

export interface MemoryWriteRejectedPayload extends JsonObject {
  scope: MemoryScope;
  reason: "working_scope_moved_to_session_summary";
}

export interface SessionCompactedPayload extends JsonObject {
  reason: "message_count" | "context_budget" | "token_budget" | "tool_call_count" | "iteration_count";
  summaryMemoryId: string;
  replacedMessageCount: number;
  summarizerId?: string;
}

export interface SessionSummaryWrittenPayload extends JsonObject {
  sessionSummaryId: string;
  sessionId: string;
  trigger: "compact" | "manual" | "resume" | "final";
  goal: string;
}

export interface SessionGoalUpdatedPayload extends JsonObject {
  previousGoal: string;
  sessionId: string;
  updatedGoal: string;
}

export interface UserMessagesPinnedPayload extends JsonObject {
  count: number;
  sessionId: string;
}

export interface ConstraintCapturedPayload extends JsonObject {
  constraints: string[];
  sessionId: string;
}

export interface FeatureBacklogUpdatedPayload extends JsonObject {
  itemCount: number;
  sessionId: string;
}

export interface FeatureBacklogFilteredPayload extends JsonObject {
  droppedCount: number;
  filteredCount: number;
  rawCount: number;
  sessionId: string;
}

export interface TaskSupersededPayload extends JsonObject {
  activeTaskId: string;
  sessionId: string;
  supersededTaskId: string;
}

export interface ScheduleCreatedPayload extends JsonObject {
  scheduleId: string;
  status: "active" | "paused";
  nextFireAt: string | null;
}

export interface ScheduleUpdatedPayload extends JsonObject {
  scheduleId: string;
  status: "active" | "paused" | "completed" | "archived";
  nextFireAt: string | null;
}

export interface ScheduleArchivedPayload extends JsonObject {
  scheduleId: string;
  status: "archived";
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

export interface ScheduleRunSkippedOverlapPayload extends JsonObject {
  activeRunId: string;
  reason: "scheduled" | "manual";
  scheduleId: string;
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
  sessionId: string | null;
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

export interface SkillContextLoadedPayload extends JsonObject {
  runId: string;
  scheduleId: string;
  loadedSkills: Array<{
    skillId: string;
    version: string;
    hash: string;
  }>;
  missingSkillIds: string[];
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
  sessionId: string | null;
  mode: RoutingMode;
  kind: RouteKind;
  tier: "cheap" | "balanced" | "quality" | null;
  providerName: string | null;
  reason: string;
}

export interface ModelSelectionUpdatedPayload extends JsonObject {
  modelName: string | null;
  providerName: string;
  selection: string;
  sessionId: string | null;
  source: "session_user" | "user" | "workspace";
}

export interface ModelSelectionClearedPayload extends JsonObject {
  priorSelection: string | null;
  sessionId: string;
}

export interface ModelFallbackPayload extends JsonObject {
  credentialId?: string | null;
  errorCategory?: ProviderErrorCategory | "unknown_error";
  fromProvider?: string;
  providerName?: string;
  reason?: string;
  selection?: string;
  slot: string;
  toProvider?: string;
}

export interface CredentialRotatedPayload extends JsonObject {
  credentialId: string | null;
  providerName: string;
  slot: string;
}

export interface BudgetWarningPayload extends JsonObject {
  taskId: string;
  sessionId: string | null;
  scope: "task" | "session";
  mode: RoutingMode;
  usedInput: number;
  usedOutput: number;
  usedCostUsd: number;
  breachedLimit: "input" | "output" | "cost" | null;
  reasons: string[];
}

export interface BudgetExceededPayload extends JsonObject {
  taskId: string;
  sessionId: string | null;
  scope: "task" | "session";
  mode: RoutingMode;
  usedInput: number;
  usedOutput: number;
  usedCostUsd: number;
  breachedLimit: "input" | "output" | "cost" | null;
  reasons: string[];
}

export interface CostReportPayload extends JsonObject {
  taskId: string;
  sessionId: string | null;
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
  sessionId: string;
  taskId: string | null;
  status: string;
  title: string;
}

export interface CommitmentUpdatedPayload extends JsonObject {
  commitmentId: string;
  sessionId: string;
  taskId: string | null;
  status: string;
  blockedReason: string | null;
  pendingDecision: string | null;
}

export interface CommitmentBlockedPayload extends JsonObject {
  commitmentId: string;
  sessionId: string;
  taskId: string | null;
  blockedReason: string;
}

export interface CommitmentUnblockedPayload extends JsonObject {
  commitmentId: string;
  sessionId: string;
  taskId: string | null;
}

export interface CommitmentCompletedPayload extends JsonObject {
  commitmentId: string;
  sessionId: string;
  taskId: string | null;
}

export interface CommitmentCancelledPayload extends JsonObject {
  commitmentId: string;
  sessionId: string;
  taskId: string | null;
}

export interface NextActionCreatedPayload extends JsonObject {
  nextActionId: string;
  commitmentId: string | null;
  sessionId: string;
  taskId: string | null;
  status: string;
  title: string;
}

export interface NextActionUpdatedPayload extends JsonObject {
  nextActionId: string;
  commitmentId: string | null;
  sessionId: string;
  taskId: string | null;
  status: string;
  blockedReason: string | null;
}

export interface NextActionBlockedPayload extends JsonObject {
  nextActionId: string;
  commitmentId: string | null;
  sessionId: string;
  taskId: string | null;
  blockedReason: string;
}

export interface NextActionDonePayload extends JsonObject {
  nextActionId: string;
  commitmentId: string | null;
  sessionId: string;
  taskId: string | null;
}

export interface WorkerDispatchedPayload extends JsonObject {
  workerId: string;
  workerKind: "summarizer" | "retrieval";
  taskId: string;
  sessionId: string | null;
  timeoutMs: number;
}

export interface WorkerSucceededPayload extends JsonObject {
  workerId: string;
  workerKind: "summarizer" | "retrieval";
  taskId: string;
  sessionId: string | null;
  durationMs: number;
  outputSummary: string;
}

export interface WorkerFailedPayload extends JsonObject {
  workerId: string;
  workerKind: "summarizer" | "retrieval";
  taskId: string;
  sessionId: string | null;
  durationMs: number;
  errorMessage: string;
  retriable: boolean;
}

export interface WorkerTimeoutPayload extends JsonObject {
  workerId: string;
  workerKind: "summarizer" | "retrieval";
  taskId: string;
  sessionId: string | null;
  timeoutMs: number;
}

export interface WorkerRetriedPayload extends JsonObject {
  workerId: string;
  workerKind: "summarizer" | "retrieval";
  taskId: string;
  sessionId: string | null;
  attemptNumber: number;
  maxAttempts: number;
  delayMs: number;
}
export interface TaskRecoveryStartedPayload extends JsonObject {
  iteration: number;
  reason: string;
  recoveryAttempt: number;
}

export interface ToolExecutionFailedPayload extends JsonObject {
  iteration: number;
  outcomeKind: string;
  toolCallId: string;
  toolName: string;
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
  | TraceEventBase<"provider_retry_scheduled", ProviderRetryScheduledPayload>
  | TraceEventBase<"provider_request_succeeded", ProviderRequestSucceededPayload>
  | TraceEventBase<"provider_request_failed", ProviderRequestFailedPayload>
  | TraceEventBase<"iteration_budget_pressure", IterationBudgetPressurePayload>
  | TraceEventBase<"iteration_exhausted">
  | TraceEventBase<"completion_verification_missing">
  | TraceEventBase<"completion_verification_satisfied">
  | TraceEventBase<"completion_verification_pending">
  | TraceEventBase<"environment_command_failed">
  | TraceEventBase<"intent_fulfillment_missing">
  | TraceEventBase<"empty_final_guarded">
  | TraceEventBase<"unpolished_final_guarded">
  | TraceEventBase<"invalid_final_output_rejected">
  | TraceEventBase<"read_only_analysis_guard">
  | TraceEventBase<"duplicate_tool_replayed">
  | TraceEventBase<"no_tools_tool_calls_ignored", NoToolsToolCallsIgnoredPayload>
  | TraceEventBase<"policy_decision", PolicyDecisionPayload>
  | TraceEventBase<"accept_edits_auto_allowed", AcceptEditsAutoAllowedPayload>
  | TraceEventBase<"approval_requested", ApprovalRequestedPayload>
  | TraceEventBase<"approval_resolved", ApprovalResolvedPayload>
  | TraceEventBase<"clarify_requested", ClarifyRequestedPayload>
  | TraceEventBase<"clarify_resolved", ClarifyResolvedPayload>
  | TraceEventBase<"clarify_cancelled", ClarifyCancelledPayload>
  | TraceEventBase<"file_rollback", FileRollbackPayload>
  | TraceEventBase<"sandbox_enforced", SandboxEnforcedPayload>
  | TraceEventBase<"tool_call_requested", ToolCallRequestedPayload>
  | TraceEventBase<"tool_call_started", ToolCallStartedPayload>
  | TraceEventBase<"tool_call_finished", ToolCallFinishedPayload>
  | TraceEventBase<"tool_call_failed", ToolCallFailedPayload>
  | TraceEventBase<"tool_call_blocked", ToolCallBlockedPayload>
  | TraceEventBase<"tool_exposure_decided", ToolExposureDecidedPayload>
  | TraceEventBase<"runtime_tool_gate_applied", RuntimeToolGateAppliedPayload>
  | TraceEventBase<"loop_iteration_completed", LoopIterationCompletedPayload>
  | TraceEventBase<"turn_end", TurnEndPayload>
  | TraceEventBase<"retry", RetryPayload>
  | TraceEventBase<"interrupt", InterruptPayload>
  | TraceEventBase<"final_outcome", FinalOutcomePayload>
  | TraceEventBase<"task_success", TaskSuccessPayload>
  | TraceEventBase<"task_failure", TaskFailurePayload>
  | TraceEventBase<"review_resolved", ReviewResolvedPayload>
  | TraceEventBase<"pre_compress", PreCompressPayload>
  | TraceEventBase<"compact_evaluated", CompactEvaluatedPayload>
  | TraceEventBase<"manual_compact_triggered", ManualCompactTriggeredPayload>
  | TraceEventBase<"tail_budget_exceeded", TailBudgetExceededPayload>
  | TraceEventBase<"micro_compact_pruned", MicroCompactPrunedPayload>
  | TraceEventBase<"compact_summarizer_failed", CompactSummarizerFailedPayload>
  | TraceEventBase<"session_end", SessionEndPayload>
  | TraceEventBase<"delegation_complete", DelegationCompletePayload>
  | TraceEventBase<"context_assembled", ContextAssembledPayload>
  | TraceEventBase<"recent_files_refetched", RecentFilesRefetchedPayload>
  | TraceEventBase<"recent_files_pinned", RecentFilesPinnedPayload>
  | TraceEventBase<"memory_context_injected", MemoryContextInjectedPayload>
  | TraceEventBase<"session_todos_injected", SessionTodosInjectedPayload>
  | TraceEventBase<"prior_task_context_injected", PriorTaskContextInjectedPayload>
  | TraceEventBase<"reactive_compact_triggered", ReactiveCompactTriggeredPayload>
  | TraceEventBase<"repo_map_created", RepoMapCreatedPayload>
  | TraceEventBase<"memory_recalled", MemoryRecalledPayload>
  | TraceEventBase<"recall_explain", RecallExplainPayload>
  | TraceEventBase<"memory_written", MemoryWrittenPayload>
  | TraceEventBase<"memory_flush_completed", MemoryFlushCompletedPayload>
  | TraceEventBase<"memory_write_rejected", MemoryWriteRejectedPayload>
  | TraceEventBase<"session_compacted", SessionCompactedPayload>
  | TraceEventBase<"session_summary_written", SessionSummaryWrittenPayload>
  | TraceEventBase<"session_goal_updated", SessionGoalUpdatedPayload>
  | TraceEventBase<"user_messages_pinned", UserMessagesPinnedPayload>
  | TraceEventBase<"constraint_captured", ConstraintCapturedPayload>
  | TraceEventBase<"feature_backlog_updated", FeatureBacklogUpdatedPayload>
  | TraceEventBase<"feature_backlog_filtered", FeatureBacklogFilteredPayload>
  | TraceEventBase<"task_superseded", TaskSupersededPayload>
  | TraceEventBase<"schedule_created", ScheduleCreatedPayload>
  | TraceEventBase<"schedule_updated", ScheduleUpdatedPayload>
  | TraceEventBase<"schedule_archived", ScheduleArchivedPayload>
  | TraceEventBase<"schedule_paused", SchedulePausedPayload>
  | TraceEventBase<"schedule_resumed", ScheduleResumedPayload>
  | TraceEventBase<"schedule_run_enqueued", ScheduleRunEnqueuedPayload>
  | TraceEventBase<"schedule_run_skipped_overlap", ScheduleRunSkippedOverlapPayload>
  | TraceEventBase<"schedule_run_started", ScheduleRunStartedPayload>
  | TraceEventBase<"schedule_run_finished", ScheduleRunFinishedPayload>
  | TraceEventBase<"schedule_run_failed", ScheduleRunFailedPayload>
  | TraceEventBase<"schedule_run_retry_scheduled", ScheduleRunRetryScheduledPayload>
  | TraceEventBase<"skill_context_loaded", SkillContextLoadedPayload>
  | TraceEventBase<"memory_snapshot_created", MemorySnapshotCreatedPayload>
  | TraceEventBase<"experience_captured", ExperienceCapturedPayload>
  | TraceEventBase<"experience_reviewed", ExperienceReviewedPayload>
  | TraceEventBase<"experience_promoted", ExperiencePromotedPayload>
  | TraceEventBase<"skill_promotion_suggested", SkillPromotionSuggestedPayload>
  | TraceEventBase<"route_decision", RouteDecisionPayload>
  | TraceEventBase<"model_selection_updated", ModelSelectionUpdatedPayload>
  | TraceEventBase<"model_selection_cleared", ModelSelectionClearedPayload>
  | TraceEventBase<"model_fallback_started", ModelFallbackPayload>
  | TraceEventBase<"model_fallback_succeeded", ModelFallbackPayload>
  | TraceEventBase<"model_fallback_exhausted", ModelFallbackPayload>
  | TraceEventBase<"credential_rotated", CredentialRotatedPayload>
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
  | TraceEventBase<"next_action_done", NextActionDonePayload>
  | TraceEventBase<"worker_dispatched", WorkerDispatchedPayload>
  | TraceEventBase<"worker_succeeded", WorkerSucceededPayload>
  | TraceEventBase<"worker_failed", WorkerFailedPayload>
  | TraceEventBase<"worker_timeout", WorkerTimeoutPayload>
  | TraceEventBase<"worker_retried", WorkerRetriedPayload>
  | TraceEventBase<"task_recovery_started", TaskRecoveryStartedPayload>
  | TraceEventBase<"tool_execution_failed", ToolExecutionFailedPayload>;

export type TraceEventDraft = Omit<TraceEvent, "eventId" | "sequence" | "timestamp"> &
  Partial<Pick<TraceEvent, "eventId" | "sequence" | "timestamp">>;

