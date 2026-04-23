import type { RuntimeErrorCode } from "./error.js";

export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "denied",
  "timed_out"
] as const;

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_ACTIONS = ["allow", "deny", "timeout"] as const;

export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

export const APPROVAL_STATUS_TRANSITIONS: Record<ApprovalStatus, ApprovalStatus[]> = {
  approved: [],
  denied: [],
  pending: ["approved", "denied", "timed_out"],
  timed_out: []
};

export interface ApprovalRecord {
  approvalId: string;
  taskId: string;
  toolCallId: string;
  toolName: string;
  requesterUserId: string;
  status: ApprovalStatus;
  reason: string;
  requestedAt: string;
  expiresAt: string;
  decidedAt: string | null;
  reviewerId: string | null;
  reviewerNotes: string | null;
  policyDecisionId: string;
  errorCode: RuntimeErrorCode | null;
}

export interface ApprovalDraft {
  approvalId: string;
  taskId: string;
  toolCallId: string;
  toolName: string;
  requesterUserId: string;
  reason: string;
  requestedAt: string;
  expiresAt: string;
  policyDecisionId: string;
}

export interface ApprovalUpdatePatch {
  status?: ApprovalStatus;
  decidedAt?: string | null;
  reviewerId?: string | null;
  reviewerNotes?: string | null;
  errorCode?: RuntimeErrorCode | null;
}

export function canTransitionApprovalStatus(
  currentStatus: ApprovalStatus,
  nextStatus: ApprovalStatus
): boolean {
  return APPROVAL_STATUS_TRANSITIONS[currentStatus].includes(nextStatus);
}
