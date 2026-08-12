import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createApplication } from "../src/runtime/index.js";
import { readRepeatRemaining } from "../src/schedule/schedule-metadata.js";
import type { Provider, ProviderResponse } from "../src/types/index.js";

class RepeatProvider implements Provider {
  public readonly name = "repeat-provider";

  public generate(): Promise<ProviderResponse> {
    return Promise.resolve({
      kind: "final",
      message: "repeat ok",
      usage: { inputTokens: 1, outputTokens: 1 }
    });
  }
}

describe("schedule repeat e2e", () => {
  it("completes one-shot schedules after repeatRemaining reaches zero", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "talon-schedule-repeat-e2e-"));
    const handle = createApplication(workspace, {
      config: { databasePath: join(workspace, "runtime.db") },
      provider: new RepeatProvider(),
      scheduler: { autoStart: false }
    });
    try {
      const schedule = handle.service.createSchedule({
        agentProfileId: "executor",
        cwd: workspace,
        input: "repeat task",
        name: "repeat schedule",
        ownerUserId: "local-user",
        providerName: handle.config.provider.name,
        repeatRemaining: 1,
        runAt: new Date(Date.now() + 60_000).toISOString()
      });
      handle.service.runScheduleNow(schedule.scheduleId);
      await handle.service.tickScheduleOnce();

      const updated = handle.service.showSchedule(schedule.scheduleId);
      expect(updated?.status).toBe("completed");
    } finally {
      handle.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("decrements repeatRemaining by one after a successful agent run", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "talon-schedule-repeat-once-"));
    const handle = createApplication(workspace, {
      config: { databasePath: join(workspace, "runtime.db") },
      provider: new RepeatProvider(),
      scheduler: { autoStart: false }
    });
    try {
      const schedule = handle.service.createSchedule({
        agentProfileId: "executor",
        cwd: workspace,
        input: "repeat task",
        name: "repeat twice",
        ownerUserId: "local-user",
        providerName: handle.config.provider.name,
        repeatRemaining: 2,
        runAt: new Date(Date.now() + 60_000).toISOString()
      });
      handle.service.runScheduleNow(schedule.scheduleId);
      await handle.service.tickScheduleOnce();

      const updated = handle.service.showSchedule(schedule.scheduleId);
      expect(updated?.status).toBe("active");
      expect(readRepeatRemaining(updated!)).toBe(1);
    } finally {
      handle.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });
});
