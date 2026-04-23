import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createApplication, createDefaultRunOptions, ThreadService } from "../src/runtime/index.js";
import type { Provider, ProviderResponse } from "../src/types/index.js";

class CompactingProvider implements Provider {
  public readonly name = "compacting";
  private call = 0;
  public generate(): Promise<ProviderResponse> {
    this.call += 1;
    if (this.call < 3) {
      return Promise.resolve({
        kind: "retry",
        delayMs: 1,
        message: "retry",
        reason: "force-loop",
        usage: { inputTokens: 1, outputTokens: 1 }
      });
    }
    return Promise.resolve({
      kind: "final",
      message: "done",
      usage: { inputTokens: 1, outputTokens: 1 }
    });
  }
}

describe("thread lineage", () => {
  it("tracks archive and branch lineage events", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "talon-lineage-"));
    const handle = createApplication(workspace, {
      config: {
        compact: {
          messageThreshold: 1,
          summarizer: "deterministic",
          tokenThreshold: 1,
          toolCallThreshold: 999
        },
        databasePath: join(workspace, "runtime.db")
      },
      provider: new CompactingProvider()
    });
    try {
      const options = createDefaultRunOptions("lineage", workspace, handle.config);
      const result = await handle.service.runTask(options);
      const threadId = result.task.threadId!;
      const threadService = new ThreadService({
        threadLineageRepository: handle.infrastructure.storage.threadLineage,
        threadRepository: handle.infrastructure.storage.threads,
        threadRunRepository: handle.infrastructure.storage.threadRuns
      });
      threadService.archiveThread(threadId);
      handle.infrastructure.storage.threadLineage.append({
        eventType: "branch",
        lineageId: "lineage-branch",
        payload: { reason: "manual test branch" },
        sourceRunId: null,
        targetRunId: null,
        threadId
      });
      const lineage = handle.infrastructure.storage.threadLineage.listByThreadId(threadId);
      expect(lineage.some((entry) => entry.eventType === "archive")).toBe(true);
      expect(lineage.some((entry) => entry.eventType === "branch")).toBe(true);
    } finally {
      handle.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });
});
