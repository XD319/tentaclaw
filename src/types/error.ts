export const RUNTIME_ERROR_CODES = [
  "approval_denied",
  "approval_required",
  "approval_timeout",
  "budget_exceeded",
  "cancelled",
  "interrupt",
  "invalid_state",
  "max_rounds_exceeded",
  "policy_denied",
  "provider_error",
  "sandbox_denied",
  "storage_error",
  "task_not_found",
  "task_not_resumable",
  "timeout",
  "tool_execution_error",
  "tool_not_found",
  "tool_unavailable",
  "tool_validation_error"
] as const;

export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[number];

export interface RuntimeErrorShape {
  code: RuntimeErrorCode;
  message: string;
  details?: Record<string, unknown> | undefined;
  cause?: unknown;
}
