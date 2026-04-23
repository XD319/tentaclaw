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
          usedOutput: 0,
          usedCostUsd: 0
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
      traceService.record({
        actor: "runtime.budget",
        eventType: "budget_warning",
        payload: {
          breachedLimit: "cost",
          mode: "balanced",
          reasons: ["soft cost limit reached"],
          scope: "task",
          taskId: "task-1",
          threadId: "thread-1",
          usedCostUsd: 0.1,
          usedInput: 100,
          usedOutput: 20
        },
        stage: "control",
        summary: "budget warning",
        taskId: "task-1"
      });
      traceService.record({
        actor: "runtime.budget",
        eventType: "budget_exceeded",
        payload: {
          breachedLimit: "cost",
          mode: "balanced",
          reasons: ["hard cost limit reached"],
          scope: "task",
          taskId: "task-1",
          threadId: "thread-1",
          usedCostUsd: 0.2,
          usedInput: 200,
          usedOutput: 40
        },
        stage: "control",
        summary: "budget exceeded",
        taskId: "task-1"
      });
      traceService.record({
        actor: "promotion.advisor",
        eventType: "skill_promotion_suggested",
        payload: {
          draftId: "draft-1",
          humanJudgmentWeight: 0.2,
          previousVersion: null,
          reasons: ["success_count=3"],
          riskLevel: "low",
          sourceExperienceIds: ["exp-1", "exp-2", "exp-3"],
          stability: 0.8,
          successCount: 3,
          successRate: 0.9,
          targetSkillId: "project:experience/retry_flaky_tests",
          version: "0.1.0"
        },
        stage: "memory",
        summary: "skill promotion suggested",
        taskId: "task-1"
      });
      collector.stop();

      const items = storage.inbox.list({ userId: "u1" });
      expect(items.some((item) => item.category === "approval_requested")).toBe(true);
      expect(items.some((item) => item.category === "task_completed")).toBe(true);
      expect(items.some((item) => item.category === "task_blocked")).toBe(true);
      expect(
        items.some(
          (item) => item.category === "skill_promotion" && item.severity === "action_required"
        )
      ).toBe(true);
      expect(items.some((item) => item.category === "budget_warning")).toBe(true);
      expect(items.some((item) => item.category === "budget_exceeded")).toBe(true);
    } finally {
      storage.close();
    }
  });
});
