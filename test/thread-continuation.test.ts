import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createApplication, createDefaultRunOptions } from "../src/runtime/index.js";
import type { Provider, ProviderResponse } from "../src/types/index.js";

class SimpleProvider implements Provider {
  public readonly name = "simple";
  public generate(): Promise<ProviderResponse> {
    return Promise.resolve({
      kind: "final",
      message: "ok",
      usage: { inputTokens: 1, outputTokens: 1 }
    });
  }
}

describe("thread continuation", () => {
  it("reuses thread id across runs and continue --last path", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "talon-thread-"));
    const handle = createApplication(workspace, {
      config: { databasePath: join(workspace, "runtime.db") },
      provider: new SimpleProvider()
    });
    try {
      const first = createDefaultRunOptions("first", workspace, handle.config);
      const firstResult = await handle.service.runTask(first);
      expect(firstResult.task.threadId).toBeTruthy();

      const continued = await handle.service.continueThread(firstResult.task.threadId!, "second", {
        cwd: workspace
      });
      expect(continued.task.threadId).toBe(firstResult.task.threadId);

      const latest = await handle.service.continueLatest("third", { cwd: workspace, userId: first.userId });
      expect(latest.task.threadId).toBe(firstResult.task.threadId);
    } finally {
      handle.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });
});
