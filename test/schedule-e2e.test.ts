import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createApplication } from "../src/runtime/index.js";
import type { Provider, ProviderResponse } from "../src/types/index.js";

class ScheduledProvider implements Provider {
  public readonly name = "scheduled-provider";

  public generate(): Promise<ProviderResponse> {
    return Promise.resolve({
      kind: "final",
      message: "scheduled result",
      usage: { inputTokens: 1, outputTokens: 1 }
    });
  }
}

describe("schedule e2e", () => {
  it("runs scheduled work and keeps task/thread traceability", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "talon-schedule-e2e-"));
    const handle = createApplication(workspace, {
      config: { databasePath: join(workspace, "runtime.db") },
      provider: new ScheduledProvider(),
      scheduler: { autoStart: true }
    });
    try {
      const schedule = handle.service.createSchedule({
        agentProfileId: "executor",
        cwd: workspace,
        every: "1m",
        input: "run scheduled action",
        name: "e2e schedule",
        ownerUserId: "local-user",
        providerName: handle.config.provider.name
      });
      handle.service.runScheduleNow(schedule.scheduleId);

      await new Promise((resolve) => setTimeout(resolve, 2_500));
      const runs = handle.service.listScheduleRuns(schedule.scheduleId, { tail: 20 });
      const completed = runs.find((run) => run.status === "completed");
      expect(completed?.taskId).toBeTruthy();
      expect(completed?.threadId).toBeTruthy();

      const taskView = handle.service.showTask(completed!.taskId!);
      expect(taskView.scheduleRuns.length).toBeGreaterThan(0);

      const threadView = handle.service.showThread(completed!.threadId!);
      expect(threadView.scheduleRuns.length).toBeGreaterThan(0);
    } finally {
      handle.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });
});
