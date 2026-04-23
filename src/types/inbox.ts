import type { JsonObject } from "./common.js";

export const INBOX_CATEGORIES = [
  "task_completed",
  "task_failed",
  "task_blocked",
  "approval_requested",
  "decision_requested",
  "memory_suggestion",
  "skill_promotion",
  "budget_warning",
  "budget_exceeded"
] as const;

export type InboxCategory = (typeof INBOX_CATEGORIES)[number];

export const INBOX_SEVERITIES = ["info", "warning", "action_required"] as const;

export type InboxSeverity = (typeof INBOX_SEVERITIES)[number];

export const INBOX_STATUSES = ["pending", "seen", "done", "dismissed"] as const;

export type InboxStatus = (typeof INBOX_STATUSES)[number];

export interface InboxItem {
  inboxId: string;
  userId: string;
  taskId: string | null;
  threadId: string | null;
  scheduleRunId: string | null;
  approvalId: string | null;
  experienceId: string | null;
  skillId: string | null;
  category: InboxCategory;
  severity: InboxSeverity;
  status: InboxStatus;
  title: string;
  summary: string;
  bodyMd: string | null;
  actionHint: string | null;
  sourceTraceId: string | null;
  dedupKey: string | null;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
  metadata: JsonObject;
}

export interface InboxItemDraft {
  inboxId?: string;
  userId: string;
  taskId?: string | null;
  threadId?: string | null;
  scheduleRunId?: string | null;
  approvalId?: string | null;
  experienceId?: string | null;
  skillId?: string | null;
  category: InboxCategory;
  severity: InboxSeverity;
  status?: InboxStatus;
  title: string;
  summary: string;
  bodyMd?: string | null;
  actionHint?: string | null;
  sourceTraceId?: string | null;
  dedupKey?: string | null;
  doneAt?: string | null;
  metadata?: JsonObject;
}

export interface InboxItemUpdatePatch {
  status?: InboxStatus;
  title?: string;
  summary?: string;
  bodyMd?: string | null;
  actionHint?: string | null;
  doneAt?: string | null;
  metadata?: JsonObject;
}

export interface InboxListQuery {
  userId?: string;
  taskId?: string;
  threadId?: string;
  category?: InboxCategory;
  status?: InboxStatus;
  statuses?: InboxStatus[];
  limit?: number;
}

export interface InboxDedupQuery {
  userId: string;
  dedupKey: string;
}

export interface InboxDeliveryEvent {
  kind: "created" | "updated";
  item: InboxItem;
}
