import { describe, expect, it } from "vitest";

import { DeliveryService } from "../src/runtime/delivery/delivery-service.js";

describe("delivery service", () => {
  it("delivers events only to matching subscribers", () => {
    const service = new DeliveryService();
    const producer = service.createProducer();
    const key = service.producerKey();

    const received: string[] = [];
    service.subscribe({ userId: "u1", status: "pending" }, (event) => {
      received.push(event.item.inboxId);
    });

    producer.publish(key, {
      item: {
        actionHint: null,
        approvalId: null,
        bodyMd: null,
        category: "task_completed",
        createdAt: new Date().toISOString(),
        dedupKey: null,
        doneAt: null,
        experienceId: null,
        inboxId: "inbox-1",
        metadata: {},
        scheduleRunId: null,
        severity: "info",
        skillId: null,
        sourceTraceId: null,
        status: "pending",
        summary: "ok",
        taskId: null,
        threadId: null,
        title: "done",
        updatedAt: new Date().toISOString(),
        userId: "u1"
      },
      kind: "created"
    });

    expect(received).toEqual(["inbox-1"]);
  });
});
