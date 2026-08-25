import { describe, expect, it, vi } from "vitest";

import { ScheduleRunLifecycle } from "../src/runtime/scheduler/schedule-run-lifecycle.js";
import { StorageManager } from "../src/storage/database.js";
import type { TaskRecord } from "../src/types/index.js";

describe("schedule run lifecycle", () => {
  it("syncs terminal task status back to the linked schedule run", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    const lifecycle = new ScheduleRunLifecycle({ scheduleRunRepository: storage.scheduleRuns });

    try {
      storage.schedules.create({
        agentProfileId: "executor",
        cwd: "/tmp/ws",
        input: "work",
        name: "once",
        nextFireAt: new Date().toISOString(),
        ownerUserId: "u1",
        providerName: "mock",
        scheduleId: "sched-1"
      });
      storage.sessions.create({
        agentProfileId: "executor",
        cwd: "/tmp/ws",
        ownerUserId: "u1",
        providerName: "mock",
        sessionId: "session-1",
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
        sessionId: null,
        tokenBudget: { inputLimit: 1, outputLimit: 1, reservedOutput: 0, usedInput: 0, usedOutput: 0 }
      });
      storage.scheduleRuns.create({
        attemptNumber: 1,
        runId: "run-1",
        scheduleId: "sched-1",
        scheduledAt: new Date().toISOString(),
        status: "waiting_approval",
        taskId: "task-1",
        trigger: "scheduled"
      });

      const task = createTask({
        metadata: {
          scheduleRunContext: {
            disallowScheduleManagement: true,
            runId: "run-1",
            scheduleId: "sched-1"
          }
        },
        status: "succeeded",
        taskId: "task-1"
      });

      const synced = lifecycle.syncRunFromTask(task);
      expect(synced?.status).toBe("completed");
      expect(synced?.taskId).toBe("task-1");
      expect(synced?.finishedAt).not.toBeNull();
    } finally {
      storage.close();
    }
  });

  it("marks waiting_approval runs as running before resume", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    const lifecycle = new ScheduleRunLifecycle({ scheduleRunRepository: storage.scheduleRuns });

    try {
      storage.schedules.create({
        agentProfileId: "executor",
        cwd: "/tmp/ws",
        input: "work",
        name: "once",
        nextFireAt: new Date().toISOString(),
        ownerUserId: "u1",
        providerName: "mock",
        scheduleId: "sched-2"
      });
      storage.sessions.create({
        agentProfileId: "executor",
        cwd: "/tmp/ws",
        ownerUserId: "u1",
        providerName: "mock",
        sessionId: "session-1",
        title: "scheduled-thread"
      });
      storage.tasks.create({
        agentProfileId: "executor",
        cwd: "/tmp/ws",
        input: "work",
        maxIterations: 1,
        providerName: "mock",
        requesterUserId: "u1",
        taskId: "task-2",
        sessionId: null,
        tokenBudget: { inputLimit: 1, outputLimit: 1, reservedOutput: 0, usedInput: 0, usedOutput: 0 }
      });
      storage.scheduleRuns.create({
        attemptNumber: 1,
        runId: "run-2",
        scheduleId: "sched-2",
        scheduledAt: new Date().toISOString(),
        status: "waiting_approval",
        taskId: "task-2",
        trigger: "scheduled"
      });

      const task = createTask({
        metadata: {
          scheduleRunContext: {
            runId: "run-2",
            scheduleId: "sched-2"
          }
        },
        status: "waiting_approval",
        taskId: "task-2"
      });

      const resumed = lifecycle.markResuming(task);
      expect(resumed?.status).toBe("running");
    } finally {
      storage.close();
    }
  });

  it("invokes onCompleted once when a run transitions to completed", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    const onCompleted = vi.fn();
    const lifecycle = new ScheduleRunLifecycle({
      onCompleted,
      scheduleRunRepository: storage.scheduleRuns
    });

    try {
      storage.schedules.create({
        agentProfileId: "executor",
        cwd: "/tmp/ws",
        input: "work",
        name: "once",
        nextFireAt: new Date().toISOString(),
        ownerUserId: "u1",
        providerName: "mock",
        scheduleId: "sched-3"
      });
      storage.tasks.create({
        agentProfileId: "executor",
        cwd: "/tmp/ws",
        input: "work",
        maxIterations: 1,
        providerName: "mock",
        requesterUserId: "u1",
        taskId: "task-3",
        sessionId: null,
        tokenBudget: { inputLimit: 1, outputLimit: 1, reservedOutput: 0, usedInput: 0, usedOutput: 0 }
      });
      storage.scheduleRuns.create({
        attemptNumber: 1,
        runId: "run-3",
        scheduleId: "sched-3",
        scheduledAt: new Date().toISOString(),
        status: "running",
        trigger: "scheduled"
      });

      const task = createTask({
        metadata: {
          scheduleRunContext: {
            runId: "run-3",
            scheduleId: "sched-3"
          }
        },
        sessionId: null,
        status: "succeeded",
        taskId: "task-3"
      });

      lifecycle.syncRunFromTask(task);
      lifecycle.syncRunFromTask(task);

      expect(onCompleted).toHaveBeenCalledTimes(1);
      expect(onCompleted).toHaveBeenCalledWith("sched-3");
    } finally {
      storage.close();
    }
  });
});

function createTask(overrides: Partial<TaskRecord> & Pick<TaskRecord, "taskId">): TaskRecord {
  const now = new Date().toISOString();
  return {
    agentProfileId: "executor",
    createdAt: now,
    currentIteration: 1,
    cwd: "/tmp/ws",
    errorCode: null,
    errorMessage: null,
    finalOutput: "done",
    finishedAt: now,
    input: "work",
    maxIterations: 4,
    metadata: {},
    providerName: "mock",
    requesterUserId: "u1",
    sessionId: "session-1",
    startedAt: now,
    status: "succeeded",
    tokenBudget: {
      inputLimit: 8_000,
      outputLimit: 2_000,
      reservedOutput: 500,
      usedInput: 0,
      usedOutput: 0
    },
    updatedAt: now,
    ...overrides
  };
}
