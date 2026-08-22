import { describe, expect, it } from "vitest";

import { publicExperienceList, publicMemoryList, publicTaskList } from "../src/session-api/public-views.js";

describe("session-api public lists", () => {
  it("caps bulky task and memory payloads for the web UI", () => {
    const tasks = publicTaskList(
      Array.from({ length: 120 }, (_, index) => ({
        input: "x".repeat(1000),
        status: "succeeded",
        taskId: `task-${String(index)}`
      }))
    );
    expect(tasks).toHaveLength(80);
    expect(JSON.stringify(tasks).includes("cwd")).toBe(false);
    expect(JSON.stringify(tasks).length).toBeLessThan(30_000);
    const withRunning = publicTaskList([
      { input: "new", status: "running", taskId: "running-now" },
      ...Array.from({ length: 120 }, (_, index) => ({
        input: "old",
        status: "succeeded",
        taskId: `old-${String(index)}`
      }))
    ]);
    expect(withRunning.some((task) => task.taskId === "running-now")).toBe(true);

    const memories = publicMemoryList([
      { content: "secret-body ".repeat(80), memoryId: "m1", title: "Note" }
    ]);
    expect(JSON.stringify(memories)).not.toContain("secret-body ".repeat(80));
    expect(publicExperienceList([{ experienceId: "e1", summary: "s", title: "t" }])).toEqual([
      { experienceId: "e1", summary: "s", title: "t" }
    ]);
  });
});
