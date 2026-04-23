import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createApplication } from "../src/runtime/index.js";
import type { Provider, ProviderResponse } from "../src/types/index.js";

class ScheduledInboxProvider implements Provider {
  public readonly name = "scheduled-inbox-provider";

  public generate(): Promise<ProviderResponse> {
    return Promise.resolve({
      kind: "final",
      message: "background done",
      usage: { inputTokens: 1, outputTokens: 1 }
    });
  }
}

describe("schedule inbox e2e", () => {
  it("writes inbox item when background run completes", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "talon-schedule-inbox-e2e-"));
    const handle = createApplication(workspace, {
      config: { databasePath: join(workspace, "runtime.db") },
      provider: new ScheduledInboxProvider(),
      scheduler: { autoStart: true }
    });
    try {
      const schedule = handle.service.createSchedule({
        agentProfileId: "executor",
        cwd: workspace,
        every: "1m",
        input: "run background action",
        name: "inbox schedule",
        ownerUserId: "local-user",
        providerName: handle.config.provider.name
      });
      handle.service.runScheduleNow(schedule.scheduleId);
      await new Promise((resolve) => setTimeout(resolve, 2500));

      const runs = handle.service.listScheduleRuns(schedule.scheduleId, { tail: 20 });
      const completed = runs.find((run) => run.status === "completed");
      expect(completed?.taskId).toBeTruthy();

      const inboxItems = handle.service.listInbox({ taskId: completed?.taskId, userId: "local-user" });
      expect(inboxItems.some((item) => item.category === "task_completed")).toBe(true);
    } finally {
      handle.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });
});
