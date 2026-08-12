import { randomUUID } from "node:crypto";

import { planRetry } from "./backoff.js";

import type { RunTaskResult } from "../application-service.js";
import type { TraceService } from "../../tracing/trace-service.js";
import { readScheduleNoAgent } from "../scheduler/schedule-metadata.js";
import type { NoAgentRunResult } from "../scheduler/no-agent-runner.js";
import type {
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
  executeNoAgent?: (request: ExecuteScheduledRunRequest) => Promise<NoAgentRunResult>;
  onRunCompleted?: (schedule: ScheduleRecord, status: "completed" | "failed") => void;
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
      const noAgent = readScheduleNoAgent(schedule);
      if (noAgent !== null && this.dependencies.executeNoAgent !== undefined) {
        return await this.executeNoAgentRun(schedule, run);
      }
      const result = await this.dependencies.execute({ run, schedule });
      const mappedStatus = this.mapTaskStatus(result.task.status);
      const next = this.dependencies.scheduleRunRepository.update(run.runId, {
        errorCode: result.task.errorCode ?? null,
        errorMessage: result.task.errorMessage ?? null,
        ...(isTerminalRunStatus(mappedStatus)
          ? { finishedAt: result.task.finishedAt ?? new Date().toISOString() }
          : {}),
        status: mappedStatus,
        taskId: result.task.taskId,
        sessionId: result.task.sessionId ?? null
      });

      if (mappedStatus === "failed") {
        this.dependencies.onRunCompleted?.(schedule, "failed");
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
      } else if (mappedStatus === "completed") {
        this.dependencies.onRunCompleted?.(schedule, "completed");
        this.safeRecord({
          actor: "scheduler",
          eventType: "schedule_run_finished",
          payload: {
            attemptNumber: next.attemptNumber,
            runId: next.runId,
            scheduleId: next.scheduleId,
            status: mappedStatus,
            taskId: next.taskId,
            sessionId: next.sessionId
          },
          stage: "completion",
          summary: `Schedule run ${run.runId} ${mappedStatus}`,
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
            sessionId: next.sessionId
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

  private async executeNoAgentRun(
    schedule: ScheduleRecord,
    run: ScheduleRunRecord
  ): Promise<ScheduleRunRecord> {
    const result = await this.dependencies.executeNoAgent!({ run, schedule });
    const mappedStatus = result.success ? "completed" : "failed";
    const next = this.dependencies.scheduleRunRepository.update(run.runId, {
      errorMessage: result.errorMessage,
      finishedAt: new Date().toISOString(),
      metadata: {
        ...run.metadata,
        noAgentOutput: result.output
      },
      status: mappedStatus
    });
    if (mappedStatus === "failed") {
      this.dependencies.onRunCompleted?.(schedule, "failed");
      this.enqueueRetryIfNeeded(schedule, next);
      this.safeRecord({
        actor: "scheduler",
        eventType: "schedule_run_failed",
        payload: {
          attemptNumber: next.attemptNumber,
          errorCode: null,
          errorMessage: next.errorMessage,
          runId: next.runId,
          scheduleId: next.scheduleId,
          taskId: null
        },
        stage: "completion",
        summary: `Schedule run ${run.runId} failed`,
        taskId: `schedule:${schedule.scheduleId}`
      });
      return next;
    }
    this.dependencies.onRunCompleted?.(schedule, "completed");
    this.safeRecord({
      actor: "scheduler",
      eventType: "schedule_run_finished",
      payload: {
        attemptNumber: next.attemptNumber,
        runId: next.runId,
        scheduleId: next.scheduleId,
        status: mappedStatus,
        taskId: null,
        sessionId: null
      },
      stage: "completion",
      summary: `Schedule run ${run.runId} ${mappedStatus}`,
      taskId: `schedule:${schedule.scheduleId}`
    });
    return next;
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

function isTerminalRunStatus(status: ScheduleRunRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
