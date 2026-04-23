import { describe, expect, it } from "vitest";

import { DeliveryService } from "../src/runtime/delivery/delivery-service.js";
import { InboxCollector } from "../src/runtime/inbox/inbox-collector.js";
import { InboxService } from "../src/runtime/inbox/inbox-service.js";
import { StorageManager } from "../src/storage/database.js";
import { TraceService } from "../src/tracing/trace-service.js";

describe("inbox collector", () => {
  it("maps task and approval traces to inbox items", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    try {
      const traceService = new TraceService(storage.traces);
      const deliveryService = new DeliveryService();
      const inboxService = new InboxService({
        deliveryProducer: deliveryService.createProducer(),
        deliveryProducerKey: deliveryService.producerKey(),
        deliveryService,
        inboxRepository: storage.inbox,
        traceService
      });
      const collector = new InboxCollector({
        findSchedule: () => null,
        findTask: (taskId) => storage.tasks.findById(taskId),
        inboxService,
        listScheduleRunsByTask: () => [],
        traceService
      });

      storage.threads.create({
        agentProfileId: "executor",
        cwd: process.cwd(),
        ownerUserId: "u1",
        providerName: "test-provider",
        threadId: "thread-1",
        title: "Thread one"
      });
      storage.tasks.create({
        agentProfileId: "executor",
        cwd: process.cwd(),
        input: "hello",
        maxIterations: 2,
        metadata: {},
        providerName: "test-provider",
        requesterUserId: "u1",
        status: "succeeded",
        taskId: "task-1",
        threadId: "thread-1",
        tokenBudget: {
          inputLimit: 1000,
          outputLimit: 1000,
          reservedOutput: 100,
          usedInput: 0,
          usedOutput: 0
        }
      });

      collector.start();
      traceService.record({
        actor: "runtime",
        eventType: "approval_requested",
        payload: {
          approvalId: "approval-1",
          expiresAt: new Date().toISOString(),
          toolCallId: "tool-1",
          toolName: "shell"
        },
        stage: "governance",
        summary: "approval requested",
        taskId: "task-1"
      });
      traceService.record({
        actor: "runtime",
        eventType: "task_success",
        payload: {
          cwd: process.cwd(),
          outputSummary: "done",
          status: "succeeded"
        },
        stage: "completion",
        summary: "task success",
        taskId: "task-1"
      });
      traceService.record({
        actor: "runtime.commitment",
        eventType: "commitment_blocked",
        payload: {
          blockedReason: "awaiting user decision",
          commitmentId: "commitment-1",
          taskId: "task-1",
          threadId: "thread-1"
        },
        stage: "planning",
        summary: "commitment blocked",
        taskId: "task-1"
      });
      collector.stop();

      const items = storage.inbox.list({ userId: "u1" });
      expect(items.some((item) => item.category === "approval_requested")).toBe(true);
      expect(items.some((item) => item.category === "task_completed")).toBe(true);
      expect(items.some((item) => item.category === "task_blocked")).toBe(true);
    } finally {
      storage.close();
    }
  });
});
