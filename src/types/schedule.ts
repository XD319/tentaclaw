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

export const ACTIVE_SCHEDULE_RUN_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "blocked"
] as const satisfies readonly ScheduleRunStatus[];

export type ActiveScheduleRunStatus = (typeof ACTIVE_SCHEDULE_RUN_STATUSES)[number];

export const SCHEDULE_RUN_TRIGGERS = ["scheduled", "manual", "retry"] as const;

export type ScheduleRunTrigger = (typeof SCHEDULE_RUN_TRIGGERS)[number];

export const SCHEDULE_DELIVERY_TARGETS = ["inbox", "origin", "silent", "webhook"] as const;

export type ScheduleDeliveryTarget = (typeof SCHEDULE_DELIVERY_TARGETS)[number];

export const SCHEDULE_RUN_STATUS_TRANSITIONS: Record<ScheduleRunStatus, ScheduleRunStatus[]> = {
  blocked: ["running", "failed", "cancelled"],
  cancelled: [],
  completed: [],
  failed: [],
  queued: ["running", "cancelled"],
  running: ["waiting_approval", "blocked", "completed", "failed", "cancelled"],
  waiting_approval: ["running", "completed", "failed", "cancelled"]
};

export interface ScheduleRecord {
  scheduleId: string;
  name: string;
  status: ScheduleStatus;
  sessionId: string | null;
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
  sessionId?: string | null;
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
  sessionId?: string | null;
  agentProfileId?: AgentProfileId;
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
  sessionId: string | null;
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
  sessionId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  trigger: ScheduleRunTrigger;
  metadata?: JsonObject;
}

export interface ScheduleRunUpdatePatch {
  status?: ScheduleRunStatus;
  scheduledAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  taskId?: string | null;
  sessionId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  metadata?: JsonObject;
}

export interface ScheduleRunListQuery {
  status?: ScheduleRunStatus;
  tail?: number;
}

export interface ScheduleStatusSummary {
  dueCount: number;
  lastRunAt: string | null;
  nextFireAt: string | null;
  runs: Record<ScheduleRunStatus, number>;
  schedules: Record<ScheduleStatus, number>;
}
