import { describe, expect, it } from "vitest";

import { DeliveryService } from "../src/runtime/delivery/delivery-service.js";
import { InboxService } from "../src/runtime/inbox/inbox-service.js";
import { StorageManager } from "../src/storage/database.js";
import { TraceService } from "../src/tracing/trace-service.js";

describe("inbox service", () => {
  it("publishes create/update events and records trace", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    try {
      const deliveryService = new DeliveryService();
      const inboxService = new InboxService({
        deliveryProducer: deliveryService.createProducer(),
        deliveryProducerKey: deliveryService.producerKey(),
        deliveryService,
        inboxRepository: storage.inbox,
        traceService: new TraceService(storage.traces)
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
        tokenBudget: {
          inputLimit: 1000,
          outputLimit: 1000,
          reservedOutput: 100,
          usedInput: 0,
          usedOutput: 0
        }
      });

      const events: Array<"created" | "updated"> = [];
      inboxService.subscribe({}, (event) => {
        events.push(event.kind);
      });

      const item = inboxService.append({
        category: "approval_requested",
        severity: "action_required",
        summary: "needs approval",
        taskId: "task-1",
        title: "Approval requested",
        userId: "u1"
      });
      inboxService.markDone(item.inboxId, "reviewer-1");

      expect(events).toEqual(["created", "updated"]);
      const trace = storage.traces.listByTaskId("task-1");
      expect(trace.some((entry) => entry.eventType === "inbox_item_created")).toBe(true);
      expect(trace.some((entry) => entry.eventType === "inbox_item_done")).toBe(true);
    } finally {
      storage.close();
    }
  });
});
