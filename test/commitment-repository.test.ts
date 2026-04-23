import { describe, expect, it } from "vitest";

import { StorageManager } from "../src/storage/database.js";

describe("commitment repositories", () => {
  it("creates and updates commitments and next actions", () => {
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

      const commitment = storage.commitments.create({
        ownerUserId: "u1",
        source: "manual",
        summary: "summary",
        threadId: "thread-1",
        title: "Ship feature"
      });
      expect(commitment.status).toBe("open");

      const updated = storage.commitments.update(commitment.commitmentId, {
        blockedReason: "waiting approval",
        status: "blocked"
      });
      expect(updated.blockedReason).toBe("waiting approval");

      const action = storage.nextActions.create({
        commitmentId: commitment.commitmentId,
        source: "manual",
        status: "active",
        threadId: "thread-1",
        title: "Ask approval"
      });
      expect(action.status).toBe("active");

      const done = storage.nextActions.update(action.nextActionId, { status: "done" });
      expect(done.status).toBe("done");
    } finally {
      storage.close();
    }
  });
});
