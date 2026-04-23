import { describe, expect, it } from "vitest";

import { StorageManager } from "../src/storage/database.js";

describe("schedule repositories", () => {
  it("creates schedules, finds due schedules, and claims queued runs", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    try {
      const now = new Date().toISOString();
      storage.schedules.create({
        agentProfileId: "executor",
        cwd: "/tmp/ws",
        input: "do work",
        name: "daily",
        nextFireAt: now,
        ownerUserId: "u1",
        providerName: "mock",
        scheduleId: "sched-1"
      });
      const due = storage.schedules.findDue({ now, limit: 10 });
      expect(due).toHaveLength(1);
      expect(due[0]?.scheduleId).toBe("sched-1");

      storage.scheduleRuns.create({
        attemptNumber: 1,
        runId: "run-1",
        scheduleId: "sched-1",
        scheduledAt: now,
        status: "queued",
        trigger: "scheduled"
      });
      const claimed = storage.scheduleRuns.claimDue(now, 5);
      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.status).toBe("running");
      expect(storage.scheduleRuns.listByScheduleId("sched-1", { tail: 10 })[0]?.status).toBe("running");
    } finally {
      storage.close();
    }
  });
});
