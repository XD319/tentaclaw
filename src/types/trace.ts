import type { JsonObject } from "./common";
import type { RuntimeErrorCode } from "./error";
import type { ToolRiskLevel } from "./tool";

export const TRACE_EVENT_TYPES = [
  "task_created",
  "task_started",
  "model_request",
  "model_response",
  "tool_call_requested",
  "tool_call_started",
  "tool_call_finished",
  "tool_call_failed",
  "loop_iteration_completed",
  "retry",
  "interrupt",
  "final_outcome"
] as const;

export type TraceEventType = (typeof TRACE_EVENT_TYPES)[number];

export const TRACE_STAGES = [
  "lifecycle",
  "planning",
  "tooling",
  "control",
  "completion"
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
}

export interface TaskStartedPayload extends JsonObject {
  maxIterations: number;
  timeoutMs: number;
}

export interface ModelRequestPayload extends JsonObject {
  iteration: number;
  inputMessageCount: number;
  availableTools: string[];
  tokenBudget: JsonObject;
}

export interface ModelResponsePayload extends JsonObject {
  iteration: number;
  kind: "final" | "retry" | "tool_calls";
  message: string;
  toolNames: string[];
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

export type TraceEvent =
  | TraceEventBase<"task_created", TaskCreatedPayload>
  | TraceEventBase<"task_started", TaskStartedPayload>
  | TraceEventBase<"model_request", ModelRequestPayload>
  | TraceEventBase<"model_response", ModelResponsePayload>
  | TraceEventBase<"tool_call_requested", ToolCallRequestedPayload>
  | TraceEventBase<"tool_call_started", ToolCallStartedPayload>
  | TraceEventBase<"tool_call_finished", ToolCallFinishedPayload>
  | TraceEventBase<"tool_call_failed", ToolCallFailedPayload>
  | TraceEventBase<"loop_iteration_completed", LoopIterationCompletedPayload>
  | TraceEventBase<"retry", RetryPayload>
  | TraceEventBase<"interrupt", InterruptPayload>
  | TraceEventBase<"final_outcome", FinalOutcomePayload>;

export type TraceEventDraft = Omit<TraceEvent, "eventId" | "sequence" | "timestamp"> &
  Partial<Pick<TraceEvent, "eventId" | "sequence" | "timestamp">>;
