import { describe, expect, it } from "vitest";

import { SchedulerService } from "../src/runtime/scheduler/scheduler-service.js";
import { StorageManager } from "../src/storage/database.js";
import { TraceService } from "../src/tracing/trace-service.js";

describe("scheduler service", () => {
  it("enqueues due runs and supports pause/resume/run-now", async () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    const traceService = new TraceService(storage.traces);
    const scheduler = new SchedulerService({
      jobRunner: {
        drain: async () => []
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

      await scheduler.tick(new Date(Date.now() + 70_000));
      const runs = scheduler.listScheduleRuns(schedule.scheduleId, { tail: 10 });
      expect(runs.length).toBeGreaterThan(1);
    } finally {
      scheduler.stop();
      storage.close();
    }
  });
});
