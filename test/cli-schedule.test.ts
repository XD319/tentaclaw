import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { main } from "../src/cli/index.js";

describe("cli schedule commands", () => {
  it("supports create/list/pause/resume/run-now flows", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "talon-cli-schedule-"));
    const previousCwd = process.cwd();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      process.chdir(workspace);
      await main(["node", "talon", "schedule", "create", "hello from cli", "--name", "cli", "--every", "5m"]);
      await main(["node", "talon", "schedule", "list"]);
      const listOutput = logSpy.mock.calls.map((entry) => String(entry[0] ?? ""));
      const line = listOutput.find((entry) => entry.includes(" | ") && entry.includes(" | cli"));
      expect(line).toBeTruthy();
      const scheduleId = line?.split(" | ")[0];
      expect(scheduleId).toBeTruthy();

      await main(["node", "talon", "schedule", "pause", scheduleId!]);
      await main(["node", "talon", "schedule", "resume", scheduleId!]);
      await main(["node", "talon", "schedule", "run-now", scheduleId!]);
    } finally {
      logSpy.mockRestore();
      process.chdir(previousCwd);
      rmSync(workspace, { force: true, recursive: true });
    }
  });
});
