import { describe, expect, it } from "vitest";

import { readRepeatRemaining } from "../src/runtime/scheduler/schedule-metadata.js";
import { SchedulerService } from "../src/runtime/scheduler/scheduler-service.js";
import type { JsonObject, ScheduleRecord } from "../src/types/index.js";

function readRepeatRemainingFromMetadata(metadata: JsonObject): number | null {
  return readRepeatRemaining({ metadata } as Pick<ScheduleRecord, "metadata"> as ScheduleRecord);
}
import { StorageManager } from "../src/storage/database.js";
import { TraceService } from "../src/tracing/trace-service.js";

describe("scheduler service", () => {
  it("enqueues due runs and supports pause/resume/run-now", async () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    const traceService = new TraceService(storage.traces);
    const scheduler = new SchedulerService({
      jobRunner: {
        drain: (now) => {
          const claimed = storage.scheduleRuns.claimDue(now, 10);
          for (const run of claimed) {
            storage.scheduleRuns.update(run.runId, {
              finishedAt: now,
              status: "completed"
            });
          }
          return Promise.resolve(claimed);
        }
      },
      scheduleRepository: storage.schedules,
      scheduleRunRepository: storage.scheduleRuns,
      traceService
    });

    try {
      const schedule = scheduler.createSchedule({
        agentProfileId: "executor",
        cwd: "/tmp/ws",
        every: "1m",
        input: "hello",
        name: "recurring",
        ownerUserId: "u1",
        providerName: "mock"
      });
      expect(schedule.status).toBe("active");

      const paused = scheduler.pauseSchedule(schedule.scheduleId);
      expect(paused.status).toBe("paused");
      const resumed = scheduler.resumeSchedule(schedule.scheduleId);
      expect(resumed.status).toBe("active");

      const manual = scheduler.runNow(schedule.scheduleId);
      expect(manual.status).toBe("queued");
      expect(manual.trigger).toBe("manual");
      storage.scheduleRuns.update(manual.runId, { status: "running" });
      storage.scheduleRuns.update(manual.runId, {
        finishedAt: new Date().toISOString(),
        status: "completed"
      });

      await scheduler.tick(new Date(Date.now() + 70_000));
      const runs = scheduler.listScheduleRuns(schedule.scheduleId, { tail: 10 });
      expect(runs.length).toBeGreaterThan(1);
    } finally {
      scheduler.stop();
      storage.close();
    }
  });

  it("edits schedules, archives without deleting runs, and reports status", async () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    const traceService = new TraceService(storage.traces);
    const scheduler = new SchedulerService({
      jobRunner: {
        drain: () => Promise.resolve([])
      },
      scheduleRepository: storage.schedules,
      scheduleRunRepository: storage.scheduleRuns,
      traceService
    });

    try {
      const schedule = scheduler.createSchedule({
        agentProfileId: "executor",
        cwd: "/tmp/ws",
        deliveryTargets: ["inbox"],
        every: "30m",
        input: "daily news",
        name: "news",
        ownerUserId: "u1",
        providerName: "mock"
      });
      const edited = scheduler.updateSchedule(schedule.scheduleId, {
        deliveryTargets: ["inbox", "origin"],
        every: "2h",
        input: "updated news",
        name: "updated"
      });
      expect(edited.intervalMs).toBe(7_200_000);
      expect(edited.input).toBe("updated news");
      expect(edited.metadata.delivery).toEqual({ targets: ["inbox", "origin"] });

      const due = scheduler.updateSchedule(schedule.scheduleId, {
        runAt: "2026-01-01T00:00:00.000Z"
      });
      expect(due.nextFireAt).toBe("2026-01-01T00:00:00.000Z");

      await scheduler.tickOnce(new Date("2026-01-01T00:00:01.000Z"));
      expect(scheduler.listScheduleRuns(schedule.scheduleId, { tail: 10 })).toHaveLength(1);
      expect(scheduler.status(new Date("2026-01-01T00:00:02.000Z")).runs.queued).toBe(1);

      const archived = scheduler.archiveSchedule(schedule.scheduleId);
      expect(archived.status).toBe("archived");
      expect(storage.schedules.findDue({ now: "2030-01-01T00:00:00.000Z" })).toHaveLength(0);
      expect(scheduler.listScheduleRuns(schedule.scheduleId, { tail: 10 })).toHaveLength(1);
    } finally {
      scheduler.stop();
      storage.close();
    }
  });

  it("preserves cadence for recurring schedules with repeatRemaining", async () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    const traceService = new TraceService(storage.traces);
    const scheduler = new SchedulerService({
      jobRunner: {
        drain: () => Promise.resolve([])
      },
      scheduleRepository: storage.schedules,
      scheduleRunRepository: storage.scheduleRuns,
      traceService
    });

    try {
      const schedule = scheduler.createSchedule({
        agentProfileId: "executor",
        cwd: "/tmp/ws",
        every: "1h",
        input: "repeat hourly",
        name: "hourly-repeat",
        ownerUserId: "u1",
        providerName: "mock",
        repeatRemaining: 2
      });
      const fireAt = new Date(schedule.nextFireAt!);
      await scheduler.tickOnce(fireAt);
      const afterEnqueue = scheduler.showSchedule(schedule.scheduleId);
      const expectedNextFireAt = new Date(fireAt.getTime() + 60 * 60 * 1000).toISOString();
      expect(afterEnqueue?.nextFireAt).toBe(expectedNextFireAt);

      const afterSuccess = scheduler.handleRepeatAfterSuccess(afterEnqueue!);
      expect(readRepeatRemainingFromMetadata(afterSuccess.metadata)).toBe(1);
      expect(afterSuccess.nextFireAt).toBe(expectedNextFireAt);
      expect(afterSuccess.status).toBe("active");
    } finally {
      scheduler.stop();
      storage.close();
    }
  });

  it("keeps one-shot schedules active until repeatRemaining reaches zero", async () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    const traceService = new TraceService(storage.traces);
    const scheduler = new SchedulerService({
      jobRunner: {
        drain: () => Promise.resolve([])
      },
      scheduleRepository: storage.schedules,
      scheduleRunRepository: storage.scheduleRuns,
      traceService
    });

    try {
      const schedule = scheduler.createSchedule({
        agentProfileId: "executor",
        cwd: "/tmp/ws",
        input: "one-shot repeat",
        name: "one-shot-repeat",
        ownerUserId: "u1",
        providerName: "mock",
        repeatRemaining: 2,
        runAt: "2026-06-01T10:00:00.000Z"
      });
      await scheduler.tickOnce(new Date("2026-06-01T10:00:01.000Z"));
      const afterFirstEnqueue = scheduler.showSchedule(schedule.scheduleId);
      expect(afterFirstEnqueue?.status).toBe("active");

      const afterFirstSuccess = scheduler.handleRepeatAfterSuccess(afterFirstEnqueue!);
      expect(readRepeatRemainingFromMetadata(afterFirstSuccess.metadata)).toBe(1);
      expect(afterFirstSuccess.nextFireAt).not.toBeNull();
      expect(afterFirstSuccess.status).toBe("active");

      await scheduler.tickOnce(new Date(afterFirstSuccess.nextFireAt!));
      const afterSecondEnqueue = scheduler.showSchedule(schedule.scheduleId);
      expect(afterSecondEnqueue?.status).toBe("active");

      const afterSecondSuccess = scheduler.handleRepeatAfterSuccess(afterSecondEnqueue!);
      expect(readRepeatRemainingFromMetadata(afterSecondSuccess.metadata)).toBeNull();
      expect(afterSecondSuccess.status).toBe("completed");
      expect(afterSecondSuccess.nextFireAt).toBeNull();
    } finally {
      scheduler.stop();
      storage.close();
    }
  });

  it("throws when pausing a missing schedule", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    const traceService = new TraceService(storage.traces);
    const scheduler = new SchedulerService({
      jobRunner: {
        drain: () => Promise.resolve([])
      },
      scheduleRepository: storage.schedules,
      scheduleRunRepository: storage.scheduleRuns,
      traceService
    });

    try {
      expect(() => scheduler.pauseSchedule("missing-schedule")).toThrow("was not found");
    } finally {
      scheduler.stop();
      storage.close();
    }
  });

  it("rejects schedule creation from blocked scheduled run metadata", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    const traceService = new TraceService(storage.traces);
    const scheduler = new SchedulerService({
      jobRunner: {
        drain: () => Promise.resolve([])
      },
      scheduleRepository: storage.schedules,
      scheduleRunRepository: storage.scheduleRuns,
      traceService
    });

    try {
      expect(() =>
        scheduler.createSchedule({
          agentProfileId: "executor",
          cwd: "/tmp/ws",
          every: "1m",
          input: "nested",
          metadata: {
            scheduleRunContext: {
              disallowScheduleManagement: true,
              runId: "run-1",
              scheduleId: "schedule-1"
            }
          },
          name: "nested",
          ownerUserId: "u1",
          providerName: "mock"
        })
      ).toThrow("Schedule creation is not allowed");

      expect(
        scheduler.createSchedule({
          agentProfileId: "executor",
          cwd: "/tmp/ws",
          every: "1m",
          input: "normal",
          name: "normal",
          ownerUserId: "u1",
          providerName: "mock"
        }).status
      ).toBe("active");
    } finally {
      scheduler.stop();
      storage.close();
    }
  });

  it("rejects runNow when an active run already exists", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    const traceService = new TraceService(storage.traces);
    const scheduler = new SchedulerService({
      jobRunner: {
        drain: () => Promise.resolve([])
      },
      scheduleRepository: storage.schedules,
      scheduleRunRepository: storage.scheduleRuns,
      traceService
    });

    try {
      const schedule = scheduler.createSchedule({
        agentProfileId: "executor",
        cwd: "/tmp/ws",
        every: "1m",
        input: "hello",
        name: "overlap",
        ownerUserId: "u1",
        providerName: "mock"
      });
      const first = scheduler.runNow(schedule.scheduleId);
      expect(() => scheduler.runNow(schedule.scheduleId)).toThrow(
        `Schedule already has an active run: ${first.runId}`
      );
    } finally {
      scheduler.stop();
      storage.close();
    }
  });

  it("skips scheduled enqueue when an active run already exists", async () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    const traceService = new TraceService(storage.traces);
    const scheduler = new SchedulerService({
      jobRunner: {
        drain: () => Promise.resolve([])
      },
      scheduleRepository: storage.schedules,
      scheduleRunRepository: storage.scheduleRuns,
      traceService
    });

    try {
      const schedule = scheduler.createSchedule({
        agentProfileId: "executor",
        cwd: "/tmp/ws",
        every: "1m",
        input: "hello",
        name: "overlap-cron",
        ownerUserId: "u1",
        providerName: "mock"
      });
      scheduler.runNow(schedule.scheduleId);
      await scheduler.tick(new Date(Date.now() + 70_000));
      const runs = scheduler.listScheduleRuns(schedule.scheduleId, { tail: 10 });
      expect(runs).toHaveLength(1);
      expect(runs[0]?.trigger).toBe("manual");
      const trace = traceService.listByTaskId(`schedule:${schedule.scheduleId}`);
      expect(trace.some((event) => event.eventType === "schedule_run_skipped_overlap")).toBe(true);
    } finally {
      scheduler.stop();
      storage.close();
    }
  });
});
