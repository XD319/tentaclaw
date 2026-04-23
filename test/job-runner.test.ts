import { describe, expect, it } from "vitest";

import { JobRunner } from "../src/runtime/jobs/job-runner.js";
import { StorageManager } from "../src/storage/database.js";
import { TraceService } from "../src/tracing/trace-service.js";

describe("job runner", () => {
  it("updates run with task/thread on success", async () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    const traceService = new TraceService(storage.traces);
    try {
      storage.schedules.create({
        agentProfileId: "executor",
        cwd: "/tmp/ws",
        input: "work",
        name: "once",
        nextFireAt: new Date().toISOString(),
        ownerUserId: "u1",
        providerName: "mock",
        scheduleId: "sched-ok"
      });
      storage.threads.create({
        agentProfileId: "executor",
        cwd: "/tmp/ws",
        ownerUserId: "u1",
        providerName: "mock",
        threadId: "thread-1",
        title: "scheduled-thread"
      });
      storage.tasks.create({
        agentProfileId: "executor",
        cwd: "/tmp/ws",
        input: "work",
        maxIterations: 1,
        providerName: "mock",
        requesterUserId: "u1",
        taskId: "task-1",
        threadId: "thread-1",
        tokenBudget: { inputLimit: 1, outputLimit: 1, reservedOutput: 0, usedInput: 0, usedOutput: 0 }
      });
      storage.scheduleRuns.create({
        attemptNumber: 1,
        runId: "run-ok-1",
        scheduleId: "sched-ok",
        scheduledAt: new Date().toISOString(),
        status: "queued",
        trigger: "scheduled"
      });
      const runner = new JobRunner({
        execute: async () => ({
          output: "done",
          task: {
            agentProfileId: "executor",
            createdAt: new Date().toISOString(),
            currentIteration: 1,
            cwd: "/tmp/ws",
            errorCode: null,
            errorMessage: null,
            finalOutput: "done",
            finishedAt: new Date().toISOString(),
            input: "work",
            maxIterations: 1,
            metadata: {},
            providerName: "mock",
            requesterUserId: "u1",
            startedAt: new Date().toISOString(),
            status: "succeeded",
            taskId: "task-1",
            threadId: "thread-1",
            tokenBudget: { inputLimit: 1, outputLimit: 1, reservedOutput: 0, usedInput: 0, usedOutput: 0 },
            updatedAt: new Date().toISOString()
          }
        }),
        scheduleRepository: storage.schedules,
        scheduleRunRepository: storage.scheduleRuns,
        traceService
      });

      const processed = await runner.drain(new Date().toISOString(), 10);
      expect(processed[0]?.status).toBe("completed");
      expect(processed[0]?.taskId).toBe("task-1");
      expect(processed[0]?.threadId).toBe("thread-1");
    } finally {
      storage.close();
    }
  });

  it("enqueues retry with backoff on failure", async () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    const traceService = new TraceService(storage.traces);
    try {
      storage.schedules.create({
        agentProfileId: "executor",
        backoffBaseMs: 10,
        backoffMaxMs: 20,
        cwd: "/tmp/ws",
        input: "work",
        maxAttempts: 2,
        name: "retry",
        nextFireAt: new Date().toISOString(),
        ownerUserId: "u1",
        providerName: "mock",
        scheduleId: "sched-fail"
      });
      storage.scheduleRuns.create({
        attemptNumber: 1,
        runId: "run-fail-1",
        scheduleId: "sched-fail",
        scheduledAt: new Date().toISOString(),
        status: "queued",
        trigger: "scheduled"
      });
      const runner = new JobRunner({
        execute: async () => {
          throw new Error("boom");
        },
        scheduleRepository: storage.schedules,
        scheduleRunRepository: storage.scheduleRuns,
        traceService
      });
      await runner.drain(new Date().toISOString(), 10);
      const runs = storage.scheduleRuns.listByScheduleId("sched-fail", { tail: 10 });
      expect(runs.some((run) => run.status === "failed")).toBe(true);
      expect(runs.some((run) => run.trigger === "retry")).toBe(true);
    } finally {
      storage.close();
    }
  });
});
