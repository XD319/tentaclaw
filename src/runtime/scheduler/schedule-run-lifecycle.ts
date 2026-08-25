import type { ScheduleRunRecord, ScheduleRunRepository, ScheduleRunStatus, TaskRecord } from "../../types/index.js";

const TERMINAL_RUN_STATUSES = new Set<ScheduleRunStatus>(["completed", "failed", "cancelled"]);

export interface ScheduleRunLifecycleDependencies {
  scheduleRunRepository: ScheduleRunRepository;
  onCompleted?: (scheduleId: string) => void;
}

export class ScheduleRunLifecycle {
  public constructor(private readonly dependencies: ScheduleRunLifecycleDependencies) {}

  public resolveRunId(task: TaskRecord): string | null {
    const context = task.metadata?.scheduleRunContext;
    if (context !== null && context !== undefined && typeof context === "object" && !Array.isArray(context)) {
      const runId = (context as Record<string, unknown>).runId;
      if (typeof runId === "string" && runId.length > 0) {
        return runId;
      }
    }
    const linked = this.dependencies.scheduleRunRepository.listByTaskId(task.taskId);
    return linked[0]?.runId ?? null;
  }

  public markResuming(task: TaskRecord): ScheduleRunRecord | null {
    const runId = this.resolveRunId(task);
    if (runId === null) {
      return null;
    }
    const existing = this.dependencies.scheduleRunRepository.findById(runId);
    if (existing === null || existing.status !== "waiting_approval") {
      return existing;
    }
    return this.dependencies.scheduleRunRepository.update(runId, {
      status: "running",
      taskId: task.taskId,
      ...(task.sessionId !== undefined ? { sessionId: task.sessionId ?? null } : {})
    });
  }

  public syncRunFromTask(task: TaskRecord): ScheduleRunRecord | null {
    const runId = this.resolveRunId(task);
    if (runId === null) {
      return null;
    }
    const existing = this.dependencies.scheduleRunRepository.findById(runId);
    if (existing === null) {
      return null;
    }
    const mappedStatus = mapTaskStatusToRunStatus(task.status);
    if (mappedStatus === null) {
      return existing;
    }
    const next = this.dependencies.scheduleRunRepository.update(runId, {
      errorCode: task.errorCode ?? null,
      errorMessage: task.errorMessage ?? null,
      ...(TERMINAL_RUN_STATUSES.has(mappedStatus)
        ? { finishedAt: task.finishedAt ?? new Date().toISOString() }
        : {}),
      sessionId: task.sessionId ?? null,
      status: mappedStatus,
      taskId: task.taskId
    });
    if (existing.status !== "completed" && next.status === "completed") {
      this.dependencies.onCompleted?.(next.scheduleId);
    }
    return next;
  }
}

function mapTaskStatusToRunStatus(status: TaskRecord["status"]): ScheduleRunStatus | null {
  switch (status) {
    case "succeeded":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "waiting_approval":
      return "waiting_approval";
    case "waiting_clarification":
      return "blocked";
    case "running":
    case "waiting_tool":
    case "pending":
      return "running";
    default:
      return null;
  }
}
