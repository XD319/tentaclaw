export const RUNTIME_ERROR_CODES = [
  "cancelled",
  "interrupt",
  "max_rounds_exceeded",
  "policy_denied",
  "provider_error",
  "storage_error",
  "timeout",
  "tool_execution_error",
  "tool_not_found",
  "tool_validation_error"
] as const;

export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[number];

export interface RuntimeErrorShape {
  code: RuntimeErrorCode;
  message: string;
  details?: Record<string, unknown> | undefined;
  cause?: unknown;
}
