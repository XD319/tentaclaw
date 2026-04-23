import type { JsonObject } from "./common.js";

export const COMMITMENT_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "waiting_decision",
  "completed",
  "cancelled"
] as const;

export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

export const COMMITMENT_SOURCES = ["user_request", "assistant_pledge", "snapshot", "manual"] as const;

export type CommitmentSource = (typeof COMMITMENT_SOURCES)[number];

export interface CommitmentRecord {
  commitmentId: string;
  threadId: string;
  taskId: string | null;
  ownerUserId: string;
  title: string;
  summary: string;
  status: CommitmentStatus;
  blockedReason: string | null;
  pendingDecision: string | null;
  source: CommitmentSource;
  sourceTraceId: string | null;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  metadata: JsonObject;
}

export interface CommitmentDraft {
  commitmentId?: string;
  threadId: string;
  taskId?: string | null;
  ownerUserId: string;
  title: string;
  summary?: string;
  status?: CommitmentStatus;
  blockedReason?: string | null;
  pendingDecision?: string | null;
  source?: CommitmentSource;
  sourceTraceId?: string | null;
  dueAt?: string | null;
  completedAt?: string | null;
  metadata?: JsonObject;
}

export interface CommitmentUpdatePatch {
  taskId?: string | null;
  title?: string;
  summary?: string;
  status?: CommitmentStatus;
  blockedReason?: string | null;
  pendingDecision?: string | null;
  source?: CommitmentSource;
  sourceTraceId?: string | null;
  dueAt?: string | null;
  completedAt?: string | null;
  metadata?: JsonObject;
}

export interface CommitmentListQuery {
  threadId?: string;
  ownerUserId?: string;
  status?: CommitmentStatus;
  statuses?: CommitmentStatus[];
  limit?: number;
}

export const NEXT_ACTION_STATUSES = ["pending", "active", "blocked", "done", "cancelled"] as const;

export type NextActionStatus = (typeof NEXT_ACTION_STATUSES)[number];

export const NEXT_ACTION_SOURCES = ["user_request", "assistant_pledge", "snapshot", "manual"] as const;

export type NextActionSource = (typeof NEXT_ACTION_SOURCES)[number];

export interface NextActionRecord {
  nextActionId: string;
  threadId: string;
  commitmentId: string | null;
  taskId: string | null;
  title: string;
  detail: string | null;
  status: NextActionStatus;
  rank: number;
  blockedReason: string | null;
  source: NextActionSource;
  sourceTraceId: string | null;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  metadata: JsonObject;
}

export interface NextActionDraft {
  nextActionId?: string;
  threadId: string;
  commitmentId?: string | null;
  taskId?: string | null;
  title: string;
  detail?: string | null;
  status?: NextActionStatus;
  rank?: number;
  blockedReason?: string | null;
  source?: NextActionSource;
  sourceTraceId?: string | null;
  dueAt?: string | null;
  completedAt?: string | null;
  metadata?: JsonObject;
}

export interface NextActionUpdatePatch {
  commitmentId?: string | null;
  taskId?: string | null;
  title?: string;
  detail?: string | null;
  status?: NextActionStatus;
  rank?: number;
  blockedReason?: string | null;
  source?: NextActionSource;
  sourceTraceId?: string | null;
  dueAt?: string | null;
  completedAt?: string | null;
  metadata?: JsonObject;
}

export interface NextActionListQuery {
  threadId?: string;
  commitmentId?: string;
  status?: NextActionStatus;
  statuses?: NextActionStatus[];
  limit?: number;
}

export interface ThreadCommitmentState {
  currentObjective: CommitmentRecord | null;
  nextAction: NextActionRecord | null;
  blockedReason: string | null;
  pendingDecision: string | null;
  openCommitments: CommitmentRecord[];
  activeNextActions: NextActionRecord[];
}
