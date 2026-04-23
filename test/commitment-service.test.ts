import { describe, expect, it } from "vitest";

import { CommitmentService } from "../src/runtime/commitments/commitment-service.js";
import { NextActionService } from "../src/runtime/commitments/next-action-service.js";
import { StorageManager } from "../src/storage/database.js";
import { TraceService } from "../src/tracing/trace-service.js";

describe("commitment services", () => {
  it("emits trace events for status transitions", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    try {
      storage.threads.create({
        agentProfileId: "executor",
        cwd: process.cwd(),
        ownerUserId: "u1",
        providerName: "test-provider",
        threadId: "thread-1",
        title: "Thread one"
      });

      const traceService = new TraceService(storage.traces);
      const commitmentService = new CommitmentService({
        commitmentRepository: storage.commitments,
        traceService
      });
      const nextActionService = new NextActionService({
        nextActionRepository: storage.nextActions,
        traceService
      });

      const commitment = commitmentService.create({
        ownerUserId: "u1",
        source: "manual",
        summary: "summary",
        threadId: "thread-1",
        title: "Deliver update"
      });
      commitmentService.block(commitment.commitmentId, "blocked");
      commitmentService.unblock(commitment.commitmentId);
      const action = nextActionService.create({
        source: "manual",
        status: "active",
        threadId: "thread-1",
        title: "Run tests"
      });
      nextActionService.markDone(action.nextActionId);

      const events = storage.traces.listByTaskId(`thread:thread-1`);
      expect(events.some((event) => event.eventType === "commitment_created")).toBe(true);
      expect(events.some((event) => event.eventType === "commitment_blocked")).toBe(true);
      expect(events.some((event) => event.eventType === "next_action_done")).toBe(true);
    } finally {
      storage.close();
    }
  });
});
