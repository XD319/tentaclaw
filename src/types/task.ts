import type { JsonObject, TokenBudget } from "./common";
import type { RuntimeErrorCode } from "./error";

export const TASK_STATUSES = [
  "pending",
  "running",
  "waiting_tool",
  "succeeded",
  "failed",
  "cancelled"
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  cancelled: [],
  failed: [],
  pending: ["running", "cancelled"],
  running: ["waiting_tool", "succeeded", "failed", "cancelled"],
  succeeded: [],
  waiting_tool: ["running", "failed", "cancelled"]
};

export interface TaskRecord {
  taskId: string;
  input: string;
  status: TaskStatus;
  cwd: string;
  providerName: string;
  currentIteration: number;
  maxIterations: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  finalOutput: string | null;
  errorCode: RuntimeErrorCode | null;
  errorMessage: string | null;
  tokenBudget: TokenBudget;
  metadata: JsonObject;
}

export interface TaskDraft {
  taskId: string;
  input: string;
  cwd: string;
  providerName: string;
  maxIterations: number;
  tokenBudget: TokenBudget;
  metadata?: JsonObject;
}

export interface RunMetadataRecord {
  runMetadataId: string;
  taskId: string;
  runtimeVersion: string;
  providerName: string;
  workspaceRoot: string;
  timeoutMs: number;
  createdAt: string;
  tokenBudget: TokenBudget;
  metadata: JsonObject;
}

export function canTransitionTaskStatus(
  currentStatus: TaskStatus,
  nextStatus: TaskStatus
): boolean {
  return TASK_STATUS_TRANSITIONS[currentStatus].includes(nextStatus);
}
