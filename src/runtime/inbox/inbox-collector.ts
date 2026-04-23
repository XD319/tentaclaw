import type { InboxService } from "./inbox-service.js";
import type {
  ScheduleRecord,
  ScheduleRunRecord,
  TaskRecord,
  TraceEvent,
  TraceService
} from "../../types/index.js";

export interface InboxCollectorDependencies {
  findSchedule: (scheduleId: string) => ScheduleRecord | null;
  findTask: (taskId: string) => TaskRecord | null;
  inboxService: InboxService;
  listScheduleRunsByTask: (taskId: string) => ScheduleRunRecord[];
  traceService: TraceService;
}

export class InboxCollector {
  private unsubscribe: (() => void) | null = null;

  public constructor(private readonly dependencies: InboxCollectorDependencies) {}

  public start(): void {
    if (this.unsubscribe !== null) {
      return;
    }
    this.unsubscribe = this.dependencies.traceService.subscribe((event) => {
      this.handleTrace(event);
    });
  }

  public stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private handleTrace(event: TraceEvent): void {
    switch (event.eventType) {
      case "task_success":
        this.dependencies.inboxService.append({
          category: "task_completed",
          dedupKey: `task_success:${event.taskId}`,
          severity: "info",
          sourceTraceId: event.eventId,
          summary: event.payload.outputSummary,
          taskId: event.taskId,
          threadId: this.dependencies.findTask(event.taskId)?.threadId ?? null,
          title: "Task completed",
          userId: this.resolveUserId(event.taskId)
        });
        return;
      case "task_failure":
        this.dependencies.inboxService.append({
          category: "task_failed",
          dedupKey: `task_failure:${event.taskId}`,
          severity: "warning",
          sourceTraceId: event.eventId,
          summary: `${event.payload.errorCode}: ${event.payload.errorMessage}`,
          taskId: event.taskId,
          threadId: this.dependencies.findTask(event.taskId)?.threadId ?? null,
          title: "Task failed",
          userId: this.resolveUserId(event.taskId)
        });
        return;
      case "approval_requested":
        this.dependencies.inboxService.append({
          actionHint: "talon approve resolve <approval-id> --action allow --reviewer <user>",
          category: "approval_requested",
          dedupKey: `approval_requested:${event.payload.approvalId}`,
          severity: "action_required",
          sourceTraceId: event.eventId,
          summary: `${event.payload.toolName} requires approval`,
          taskId: event.taskId,
          threadId: this.dependencies.findTask(event.taskId)?.threadId ?? null,
          title: "Approval requested",
          userId: this.resolveUserId(event.taskId)
        });
        return;
      case "approval_resolved": {
        const pending = this.dependencies.inboxService
          .list({ status: "pending", taskId: event.taskId })
          .find((item) => item.dedupKey === `approval_requested:${event.payload.approvalId}`);
        if (pending !== undefined) {
          this.dependencies.inboxService.markDone(
            pending.inboxId,
            event.payload.reviewerId ?? "system-reviewer"
          );
        }
        return;
      }
      case "experience_promoted":
        if (event.payload.target === "project_memory") {
          this.dependencies.inboxService.append({
            category: "memory_suggestion",
            dedupKey: `memory_suggestion:${event.payload.experienceId}`,
            experienceId: event.payload.experienceId,
            severity: "info",
            sourceTraceId: event.eventId,
            summary: "A new memory candidate has been promoted.",
            taskId: event.taskId,
            title: "Memory suggestion",
            userId: this.resolveUserId(event.taskId)
          });
        }
        if (event.payload.target === "skill_candidate") {
          this.dependencies.inboxService.append({
            category: "skill_promotion",
            dedupKey: `skill_promotion:${event.payload.experienceId}`,
            experienceId: event.payload.experienceId,
            severity: "info",
            sourceTraceId: event.eventId,
            summary: "A new skill candidate is ready for promotion.",
            taskId: event.taskId,
            title: "Skill promotion suggestion",
            userId: this.resolveUserId(event.taskId)
          });
        }
        return;
      case "schedule_run_finished":
        if (event.payload.status !== "completed") {
          return;
        }
        this.dependencies.inboxService.append({
          category: "task_completed",
          dedupKey: `schedule_run_finished:${event.payload.runId}`,
          scheduleRunId: event.payload.runId,
          severity: "info",
          sourceTraceId: event.eventId,
          summary: `Background schedule run ${event.payload.runId} completed.`,
          taskId: event.payload.taskId ?? event.taskId,
          threadId: event.payload.threadId,
          title: "Background task completed",
          userId: this.resolveScheduleOwner(event.payload.scheduleId, event.taskId)
        });
        return;
      case "commitment_blocked":
        this.dependencies.inboxService.append({
          category: "task_blocked",
          dedupKey: `task_blocked:${event.payload.commitmentId}`,
          severity: "warning",
          sourceTraceId: event.eventId,
          summary: event.payload.blockedReason,
          taskId: event.payload.taskId,
          threadId: event.payload.threadId,
          title: "Task blocked",
          userId: this.resolveUserId(event.taskId)
        });
        return;
      case "next_action_blocked":
        this.dependencies.inboxService.append({
          category: "task_blocked",
          dedupKey: `task_blocked:next_action:${event.payload.nextActionId}`,
          severity: "warning",
          sourceTraceId: event.eventId,
          summary: event.payload.blockedReason,
          taskId: event.payload.taskId,
          threadId: event.payload.threadId,
          title: "Next action blocked",
          userId: this.resolveUserId(event.taskId)
        });
        return;
      case "commitment_updated":
        if (event.payload.status !== "waiting_decision" || event.payload.pendingDecision === null) {
          return;
        }
        this.dependencies.inboxService.append({
          category: "decision_requested",
          dedupKey: `decision_requested:${event.payload.commitmentId}`,
          severity: "action_required",
          sourceTraceId: event.eventId,
          summary: event.payload.pendingDecision,
          taskId: event.payload.taskId,
          threadId: event.payload.threadId,
          title: "Decision requested",
          userId: this.resolveUserId(event.taskId)
        });
        return;
      default:
        return;
    }
  }

  private resolveUserId(taskId: string): string {
    const task = this.dependencies.findTask(taskId);
    if (task !== null) {
      return task.requesterUserId;
    }
    const run = this.dependencies.listScheduleRunsByTask(taskId)[0];
    if (run !== undefined) {
      const schedule = this.dependencies.findSchedule(run.scheduleId);
      if (schedule !== null) {
        return schedule.ownerUserId;
      }
    }
    return "local-user";
  }

  private resolveScheduleOwner(scheduleId: string, fallbackTaskId: string): string {
    const schedule = this.dependencies.findSchedule(scheduleId);
    if (schedule !== null) {
      return schedule.ownerUserId;
    }
    return this.resolveUserId(fallbackTaskId);
  }
}
