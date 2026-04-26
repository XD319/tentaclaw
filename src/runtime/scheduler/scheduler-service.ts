import { randomUUID } from "node:crypto";

import { computeNextFireAt, parseEveryExpression } from "./next-fire.js";

import type { JobRunner } from "../jobs/job-runner.js";
import type { TraceService } from "../../tracing/trace-service.js";
import type {
  ScheduleDraft,
  ScheduleListQuery,
  ScheduleRecord,
  ScheduleRepository,
  ScheduleRunListQuery,
  ScheduleRunRecord,
  ScheduleRunRepository
} from "../../types/index.js";

export interface CreateScheduleInput {
  name: string;
  ownerUserId: string;
  cwd: string;
  agentProfileId: ScheduleRecord["agentProfileId"];
  providerName: string;
  input: string;
  threadId?: string | null;
  runAt?: string | null;
  every?: string | null;
  cron?: string | null;
  timezone?: string | null;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export interface SchedulerServiceDependencies {
  scheduleRepository: ScheduleRepository;
  scheduleRunRepository: ScheduleRunRepository;
  jobRunner: JobRunner;
  traceService: TraceService;
  pollIntervalMs?: number;
}

export class SchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private tickInProgress = false;

  public constructor(private readonly dependencies: SchedulerServiceDependencies) {}

  public start(): void {
    if (this.timer !== null) {
      return;
    }
    const pollIntervalMs = this.dependencies.pollIntervalMs ?? 2_000;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Unknown scheduler tick error.";
        this.dependencies.traceService.record({
          actor: "scheduler",
          eventType: "schedule_run_failed",
          payload: {
            attemptNumber: 0,
            errorCode: null,
            errorMessage: message,
            runId: "scheduler_tick",
            scheduleId: "scheduler",
            taskId: null
          },
          stage: "control",
          summary: "Scheduler tick failed",
          taskId: "scheduler:tick"
        });
      });
    }, pollIntervalMs);
  }

  public stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async tick(now = new Date()): Promise<void> {
    if (this.tickInProgress) {
      return;
    }
    this.tickInProgress = true;
    try {
      const nowIso = now.toISOString();
      const dueSchedules = this.dependencies.scheduleRepository.findDue({ now: nowIso, limit: 25 });
      for (const schedule of dueSchedules) {
        this.enqueueScheduledRun(schedule, now);
      }
      await this.dependencies.jobRunner.drain(nowIso);
    } finally {
      this.tickInProgress = false;
    }
  }

  public createSchedule(input: CreateScheduleInput): ScheduleRecord {
    const draft = this.buildScheduleDraft(input);
    const schedule = this.dependencies.scheduleRepository.create(draft);
    this.dependencies.traceService.record({
      actor: "scheduler",
      eventType: "schedule_created",
      payload: {
        nextFireAt: schedule.nextFireAt,
        scheduleId: schedule.scheduleId,
        status: schedule.status === "paused" ? "paused" : "active"
      },
      stage: "control",
      summary: `Schedule ${schedule.scheduleId} created`,
      taskId: `schedule:${schedule.scheduleId}`
    });
    return schedule;
  }

  public listSchedules(query?: ScheduleListQuery): ScheduleRecord[] {
    return this.dependencies.scheduleRepository.list(query);
  }

  public showSchedule(scheduleId: string): ScheduleRecord | null {
    return this.dependencies.scheduleRepository.findById(scheduleId);
  }

  public listScheduleRuns(scheduleId: string, query?: ScheduleRunListQuery): ScheduleRunRecord[] {
    return this.dependencies.scheduleRunRepository.listByScheduleId(scheduleId, query);
  }

  public pauseSchedule(scheduleId: string): ScheduleRecord {
    const schedule = this.dependencies.scheduleRepository.update(scheduleId, { status: "paused" });
    this.dependencies.traceService.record({
      actor: "scheduler",
      eventType: "schedule_paused",
      payload: {
        scheduleId: schedule.scheduleId,
        status: "paused"
      },
      stage: "control",
      summary: `Schedule ${schedule.scheduleId} paused`,
      taskId: `schedule:${schedule.scheduleId}`
    });
    return schedule;
  }

  public resumeSchedule(scheduleId: string): ScheduleRecord {
    const existing = this.dependencies.scheduleRepository.findById(scheduleId);
    if (existing === null) {
      throw new Error(`Schedule ${scheduleId} was not found.`);
    }
    const resumed = this.dependencies.scheduleRepository.update(scheduleId, {
      nextFireAt: this.computeResumeFireAt(existing),
      status: "active"
    });
    this.dependencies.traceService.record({
      actor: "scheduler",
      eventType: "schedule_resumed",
      payload: {
        nextFireAt: resumed.nextFireAt,
        scheduleId: resumed.scheduleId,
        status: "active"
      },
      stage: "control",
      summary: `Schedule ${resumed.scheduleId} resumed`,
      taskId: `schedule:${resumed.scheduleId}`
    });
    return resumed;
  }

  public runNow(scheduleId: string): ScheduleRunRecord {
    const schedule = this.dependencies.scheduleRepository.findById(scheduleId);
    if (schedule === null) {
      throw new Error(`Schedule ${scheduleId} was not found.`);
    }
    const latest = this.dependencies.scheduleRunRepository.listByScheduleId(scheduleId, { tail: 1 });
    const run = this.dependencies.scheduleRunRepository.create({
      attemptNumber: (latest[0]?.attemptNumber ?? 0) + 1,
      runId: randomUUID(),
      scheduleId,
      scheduledAt: new Date().toISOString(),
      status: "queued",
      trigger: "manual"
    });
    this.recordRunEnqueued(run);
    return run;
  }

  private enqueueScheduledRun(schedule: ScheduleRecord, now: Date): ScheduleRunRecord {
    const latest = this.dependencies.scheduleRunRepository.listByScheduleId(schedule.scheduleId, { tail: 1 });
    const run = this.dependencies.scheduleRunRepository.create({
      attemptNumber: (latest[0]?.attemptNumber ?? 0) + 1,
      runId: randomUUID(),
      scheduleId: schedule.scheduleId,
      scheduledAt: now.toISOString(),
      status: "queued",
      trigger: "scheduled"
    });
    const nextFire = computeNextFireAt(schedule, now);
    this.dependencies.scheduleRepository.update(schedule.scheduleId, {
      lastFireAt: now.toISOString(),
      nextFireAt: nextFire?.toISOString() ?? null,
      status: nextFire === null ? "completed" : schedule.status
    });
    this.recordRunEnqueued(run);
    return run;
  }

  private recordRunEnqueued(run: ScheduleRunRecord): void {
    this.dependencies.traceService.record({
      actor: "scheduler",
      eventType: "schedule_run_enqueued",
      payload: {
        attemptNumber: run.attemptNumber,
        runId: run.runId,
        scheduledAt: run.scheduledAt,
        scheduleId: run.scheduleId,
        trigger: run.trigger
      },
      stage: "control",
      summary: `Schedule run ${run.runId} enqueued`,
      taskId: `schedule:${run.scheduleId}`
    });
  }

  private buildScheduleDraft(input: CreateScheduleInput): ScheduleDraft {
    const intervalMs = input.every === undefined || input.every === null ? null : parseEveryExpression(input.every);
    const runAt = input.runAt ?? null;
    const cron = input.cron ?? null;
    if (intervalMs === null && cron === null && runAt === null) {
      throw new Error("Schedule must define one of runAt, every, or cron.");
    }
    const nextFireAt =
      runAt !== null
        ? runAt
        : computeNextFireAt(
            {
              cron,
              intervalMs,
              timezone: input.timezone ?? null
            },
            new Date()
          )?.toISOString() ?? null;
    return {
      agentProfileId: input.agentProfileId,
      backoffBaseMs: input.backoffBaseMs ?? 5_000,
      backoffMaxMs: input.backoffMaxMs ?? 300_000,
      cron,
      cwd: input.cwd,
      input: input.input,
      intervalMs,
      maxAttempts: input.maxAttempts ?? 3,
      name: input.name,
      nextFireAt,
      ownerUserId: input.ownerUserId,
      providerName: input.providerName,
      runAt,
      scheduleId: randomUUID(),
      threadId: input.threadId ?? null,
      timezone: input.timezone ?? null
    };
  }

  private computeResumeFireAt(schedule: ScheduleRecord): string | null {
    if (schedule.runAt !== null) {
      return schedule.runAt;
    }
    return computeNextFireAt(schedule, new Date())?.toISOString() ?? null;
  }
}
