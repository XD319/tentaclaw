import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { main } from "../src/cli/index.js";

describe("cli inbox commands", () => {
  it("supports list/show/done flow", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "talon-cli-inbox-"));
    const previousCwd = process.cwd();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      process.chdir(workspace);
      await main(["node", "talon", "run", "hello inbox"]);
      await main(["node", "talon", "inbox", "list", "--status", "pending"]);
      const listOutput = logSpy.mock.calls.map((entry) => String(entry[0] ?? ""));
      const inboxLine = listOutput.find((line) => line.includes(" | pending | "));
      expect(inboxLine).toBeTruthy();
      const inboxId = inboxLine?.split(" | ")[0];
      expect(inboxId).toBeTruthy();

      await main(["node", "talon", "inbox", "show", inboxId!]);
      await main(["node", "talon", "inbox", "done", inboxId!]);
    } finally {
      logSpy.mockRestore();
      process.chdir(previousCwd);
      rmSync(workspace, { force: true, recursive: true });
    }
  });
});
