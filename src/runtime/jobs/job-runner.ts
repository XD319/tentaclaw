import { randomUUID } from "node:crypto";

import { planRetry } from "./backoff.js";

import type { RunTaskResult } from "../application-service.js";
import type { TraceService } from "../../tracing/trace-service.js";
import type {
  RuntimeRunOptions,
  ScheduleRecord,
  ScheduleRepository,
  ScheduleRunRecord,
  ScheduleRunRepository
} from "../../types/index.js";

export interface ExecuteScheduledRunRequest {
  schedule: ScheduleRecord;
  run: ScheduleRunRecord;
}

export type ExecuteScheduledRunResult = RunTaskResult;

export interface JobRunnerDependencies {
  scheduleRepository: ScheduleRepository;
  scheduleRunRepository: ScheduleRunRepository;
  traceService: TraceService;
  execute: (request: ExecuteScheduledRunRequest) => Promise<ExecuteScheduledRunResult>;
}

export class JobRunner {
  public constructor(private readonly dependencies: JobRunnerDependencies) {}

  public async drain(now = new Date().toISOString(), limit = 10): Promise<ScheduleRunRecord[]> {
    const claimed = this.dependencies.scheduleRunRepository.claimDue(now, limit);
    const processed: ScheduleRunRecord[] = [];
    for (const run of claimed) {
      const schedule = this.dependencies.scheduleRepository.findById(run.scheduleId);
      if (schedule === null) {
        const failed = this.dependencies.scheduleRunRepository.update(run.runId, {
          errorMessage: `Schedule ${run.scheduleId} not found`,
          finishedAt: new Date().toISOString(),
          status: "failed"
        });
        processed.push(failed);
        continue;
      }
      processed.push(await this.executeRun(schedule, run));
    }
    return processed;
  }

  private async executeRun(schedule: ScheduleRecord, run: ScheduleRunRecord): Promise<ScheduleRunRecord> {
    this.safeRecord({
      actor: "scheduler",
      eventType: "schedule_run_started",
      payload: {
        attemptNumber: run.attemptNumber,
        runId: run.runId,
        scheduleId: schedule.scheduleId
      },
      stage: "control",
      summary: `Schedule run ${run.runId} started`,
      taskId: run.taskId ?? `schedule:${schedule.scheduleId}`
    });
    try {
      const result = await this.dependencies.execute({ run, schedule });
      const mappedStatus = this.mapTaskStatus(result.task.status);
      const next = this.dependencies.scheduleRunRepository.update(run.runId, {
        errorCode: result.task.errorCode ?? null,
        errorMessage: result.task.errorMessage ?? null,
        finishedAt: result.task.finishedAt ?? new Date().toISOString(),
        status: mappedStatus,
        taskId: result.task.taskId,
        threadId: result.task.threadId ?? null
      });

      if (mappedStatus === "failed") {
        this.enqueueRetryIfNeeded(schedule, next);
        this.safeRecord({
          actor: "scheduler",
          eventType: "schedule_run_failed",
          payload: {
            attemptNumber: next.attemptNumber,
            errorCode: next.errorCode,
            errorMessage: next.errorMessage,
            runId: next.runId,
            scheduleId: next.scheduleId,
            taskId: next.taskId
          },
          stage: "completion",
          summary: `Schedule run ${run.runId} failed`,
          taskId: next.taskId ?? `schedule:${schedule.scheduleId}`
        });
      } else {
        this.safeRecord({
          actor: "scheduler",
          eventType: "schedule_run_finished",
          payload: {
            attemptNumber: next.attemptNumber,
            runId: next.runId,
            scheduleId: next.scheduleId,
            status: mappedStatus,
            taskId: next.taskId,
            threadId: next.threadId
          },
          stage: "completion",
          summary: `Schedule run ${run.runId} ${mappedStatus}`,
          taskId: next.taskId ?? `schedule:${schedule.scheduleId}`
        });
      }
      return next;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown scheduled run failure";
      const failed = this.dependencies.scheduleRunRepository.update(run.runId, {
        errorMessage: message,
        finishedAt: new Date().toISOString(),
        status: "failed"
      });
      this.enqueueRetryIfNeeded(schedule, failed);
      this.safeRecord({
        actor: "scheduler",
        eventType: "schedule_run_failed",
        payload: {
          attemptNumber: failed.attemptNumber,
          errorCode: failed.errorCode,
          errorMessage: failed.errorMessage,
          runId: failed.runId,
          scheduleId: failed.scheduleId,
          taskId: failed.taskId
        },
        stage: "completion",
        summary: `Schedule run ${run.runId} failed`,
        taskId: failed.taskId ?? `schedule:${schedule.scheduleId}`
      });
      return failed;
    }
  }

  private enqueueRetryIfNeeded(
    schedule: ScheduleRecord,
    run: ScheduleRunRecord
  ): ScheduleRunRecord | null {
    const retry = planRetry(schedule, run);
    if (retry === null) {
      return null;
    }
    const retryRun = this.dependencies.scheduleRunRepository.create({
      attemptNumber: run.attemptNumber + 1,
      runId: randomUUID(),
      scheduleId: run.scheduleId,
      scheduledAt: retry.retryAt,
      status: "queued",
      trigger: "retry"
    });
    this.safeRecord({
      actor: "scheduler",
      eventType: "schedule_run_retry_scheduled",
      payload: {
        delayMs: retry.delayMs,
        nextAttemptNumber: retryRun.attemptNumber,
        priorRunId: run.runId,
        retryAt: retry.retryAt,
        retryRunId: retryRun.runId,
        scheduleId: run.scheduleId
      },
      stage: "control",
      summary: `Retry scheduled for run ${run.runId}`,
      taskId: run.taskId ?? `schedule:${schedule.scheduleId}`
    });
    return retryRun;
  }

  private safeRecord(event: Parameters<TraceService["record"]>[0]): void {
    try {
      this.dependencies.traceService.record(event);
    } catch {
      // Scheduled execution should not fail because trace persistence failed.
    }
  }

  private mapTaskStatus(status: RunTaskResult["task"]["status"]): ScheduleRunRecord["status"] {
    if (status === "succeeded") {
      return "completed";
    }
    if (status === "failed") {
      return "failed";
    }
    if (status === "cancelled") {
      return "cancelled";
    }
    if (status === "waiting_approval") {
      return "waiting_approval";
    }
    return "blocked";
  }
}

export function buildRunOptionsForSchedule(schedule: ScheduleRecord): RuntimeRunOptions {
  return {
    agentProfileId: schedule.agentProfileId,
    cwd: schedule.cwd,
    maxIterations: 12,
    taskInput: schedule.input,
    ...(schedule.threadId !== null ? { threadId: schedule.threadId } : {}),
    timeoutMs: 120_000,
    tokenBudget: {
      inputLimit: 64_000,
      outputLimit: 8_000,
      reservedOutput: 1_000,
      usedInput: 0,
      usedOutput: 0,
      usedCostUsd: 0
    },
    userId: schedule.ownerUserId
  };
}
