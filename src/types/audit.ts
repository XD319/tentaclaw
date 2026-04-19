import type { JsonObject } from "./common";

export const AUDIT_ACTIONS = [
  "gateway_capability_degraded",
  "gateway_request",
  "approval_requested",
  "approval_resolved",
  "file_rollback",
  "file_write",
  "high_risk_tool_requested",
  "policy_decision",
  "sandbox_enforced",
  "shell_execution",
  "tool_failure",
  "tool_rejected",
  "web_fetch"
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_OUTCOMES = [
  "approved",
  "attempted",
  "denied",
  "failed",
  "pending",
  "succeeded",
  "timed_out"
] as const;

export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export interface AuditLogRecord {
  auditId: string;
  taskId: string | null;
  toolCallId: string | null;
  approvalId: string | null;
  actor: string;
  action: AuditAction;
  outcome: AuditOutcome;
  summary: string;
  payload: JsonObject;
  createdAt: string;
}

export interface AuditLogDraft {
  auditId: string;
  taskId: string | null;
  toolCallId: string | null;
  approvalId: string | null;
  actor: string;
  action: AuditAction;
  outcome: AuditOutcome;
  summary: string;
  payload: JsonObject;
  createdAt: string;
}
