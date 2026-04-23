import { describe, expect, it } from "vitest";

import { StorageManager } from "../src/storage/database.js";

describe("inbox repository", () => {
  it("creates, lists, and updates inbox items", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    try {
      const created = storage.inbox.create({
        category: "task_completed",
        dedupKey: "task:1",
        severity: "info",
        summary: "Task finished",
        title: "Task completed",
        userId: "u1"
      });
      expect(created.inboxId).toBeTruthy();
      const byDedup = storage.inbox.findByDedup({ dedupKey: "task:1", userId: "u1" });
      expect(byDedup?.inboxId).toBe(created.inboxId);

      const listed = storage.inbox.list({ userId: "u1", status: "pending" });
      expect(listed).toHaveLength(1);

      const done = storage.inbox.update(created.inboxId, { doneAt: new Date().toISOString(), status: "done" });
      expect(done.status).toBe("done");
    } finally {
      storage.close();
    }
  });
});
