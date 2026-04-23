import type { JsonObject } from "./common.js";
import type { AgentProfileId } from "./profile.js";

export const SCHEDULE_STATUSES = ["active", "paused", "completed", "archived"] as const;

export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

export const SCHEDULE_RUN_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "blocked",
  "completed",
  "failed",
  "cancelled"
] as const;

export type ScheduleRunStatus = (typeof SCHEDULE_RUN_STATUSES)[number];

export const SCHEDULE_RUN_TRIGGERS = ["scheduled", "manual", "retry"] as const;

export type ScheduleRunTrigger = (typeof SCHEDULE_RUN_TRIGGERS)[number];

export const SCHEDULE_RUN_STATUS_TRANSITIONS: Record<ScheduleRunStatus, ScheduleRunStatus[]> = {
  blocked: ["running", "failed", "cancelled"],
  cancelled: [],
  completed: [],
  failed: [],
  queued: ["running", "cancelled"],
  running: ["waiting_approval", "blocked", "completed", "failed", "cancelled"],
  waiting_approval: ["running", "failed", "cancelled"]
};

export interface ScheduleRecord {
  scheduleId: string;
  name: string;
  status: ScheduleStatus;
  threadId: string | null;
  ownerUserId: string;
  cwd: string;
  agentProfileId: AgentProfileId;
  providerName: string;
  input: string;
  runAt: string | null;
  intervalMs: number | null;
  cron: string | null;
  timezone: string | null;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  nextFireAt: string | null;
  lastFireAt: string | null;
  createdAt: string;
  updatedAt: string;
  metadata: JsonObject;
}

export interface ScheduleDraft {
  scheduleId: string;
  name: string;
  threadId?: string | null;
  ownerUserId: string;
  cwd: string;
  agentProfileId: AgentProfileId;
  providerName: string;
  input: string;
  runAt?: string | null;
  intervalMs?: number | null;
  cron?: string | null;
  timezone?: string | null;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  nextFireAt?: string | null;
  lastFireAt?: string | null;
  metadata?: JsonObject;
}

export interface ScheduleUpdatePatch {
  name?: string;
  status?: ScheduleStatus;
  threadId?: string | null;
  input?: string;
  runAt?: string | null;
  intervalMs?: number | null;
  cron?: string | null;
  timezone?: string | null;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  nextFireAt?: string | null;
  lastFireAt?: string | null;
  metadata?: JsonObject;
}

export interface ScheduleListQuery {
  ownerUserId?: string;
  status?: ScheduleStatus;
}

export interface ScheduleDueQuery {
  now: string;
  limit?: number;
}

export interface ScheduleRunRecord {
  runId: string;
  scheduleId: string;
  attemptNumber: number;
  status: ScheduleRunStatus;
  scheduledAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  taskId: string | null;
  threadId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  trigger: ScheduleRunTrigger;
  metadata: JsonObject;
}

export interface ScheduleRunDraft {
  runId: string;
  scheduleId: string;
  attemptNumber: number;
  status: ScheduleRunStatus;
  scheduledAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  taskId?: string | null;
  threadId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  trigger: ScheduleRunTrigger;
  metadata?: JsonObject;
}

export interface ScheduleRunUpdatePatch {
  status?: ScheduleRunStatus;
  startedAt?: string | null;
  finishedAt?: string | null;
  taskId?: string | null;
  threadId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  metadata?: JsonObject;
}

export interface ScheduleRunListQuery {
  status?: ScheduleRunStatus;
  tail?: number;
}
