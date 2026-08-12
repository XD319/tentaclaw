import { describe, expect, it, vi } from "vitest";

import { WebhookDeliveryService } from "../src/runtime/delivery/webhook-delivery.js";
import type { ScheduleRecord } from "../src/types/index.js";

describe("WebhookDeliveryService", () => {
  it("posts schedule outcomes to the configured webhook", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    const service = new WebhookDeliveryService({ fetchImpl });
    const schedule = createSchedule();

    await service.deliverScheduleOutcome(schedule, {
      category: "task_completed",
      errorCode: null,
      errorMessage: null,
      output: "done",
      runId: "run-1",
      scheduleId: schedule.scheduleId,
      scheduleName: schedule.name,
      status: "completed",
      taskId: "task-1"
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.com/hook",
      expect.objectContaining({
        method: "POST"
      })
    );
  });

  it("rejects private webhook targets before invoking fetchImpl", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    const onFailure = vi.fn();
    const service = new WebhookDeliveryService({ fetchImpl, onFailure });
    const schedule = createSchedule({
      delivery: {
        targets: ["webhook"],
        webhookUrl: "http://127.0.0.1/hook"
      }
    });

    await service.deliverScheduleOutcome(schedule, {
      category: "task_completed",
      errorCode: null,
      errorMessage: null,
      output: "done",
      runId: "run-1",
      scheduleId: schedule.scheduleId,
      scheduleName: schedule.name,
      status: "completed",
      taskId: "task-1"
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: schedule.scheduleId,
        webhookUrl: "http://127.0.0.1/hook"
      })
    );
  });
});

function createSchedule(metadata?: ScheduleRecord["metadata"]): ScheduleRecord {
  return {
    agentProfileId: "executor",
    backoffBaseMs: 5_000,
    backoffMaxMs: 300_000,
    createdAt: "2026-01-01T00:00:00.000Z",
    cron: null,
    cwd: process.cwd(),
    input: "task",
    intervalMs: null,
    lastFireAt: null,
    maxAttempts: 3,
    metadata: metadata ?? {
      delivery: {
        targets: ["webhook"],
        webhookUrl: "https://example.com/hook"
      }
    },
    name: "webhook schedule",
    nextFireAt: null,
    ownerUserId: "local-user",
    providerName: "mock",
    runAt: null,
    scheduleId: "schedule-1",
    sessionId: null,
    status: "active",
    timezone: null,
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
