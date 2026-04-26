import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createApplication, createDefaultRunOptions } from "../src/runtime/index.js";
import type { Provider, ProviderResponse } from "../src/types/index.js";

class ToolThenFinalProvider implements Provider {
  public readonly name = "tool-then-final";
  private callCount = 0;

  public generate(): Promise<ProviderResponse> {
    this.callCount += 1;
    if (this.callCount === 1) {
      return Promise.resolve({
        kind: "tool_calls",
        message: "Read a file first",
        toolCalls: [
          {
            input: {
              action: "list_dir",
              path: "."
            },
            reason: "Need project context",
            toolCallId: "tc-read-1",
            toolName: "file_read"
          }
        ],
        usage: { inputTokens: 1, outputTokens: 1 }
      });
    }
    return Promise.resolve({
      kind: "final",
      message: "complete",
      usage: { inputTokens: 1, outputTokens: 1 }
    });
  }
}

class ImmediateFinalProvider implements Provider {
  public readonly name = "immediate-final";

  public generate(): Promise<ProviderResponse> {
    return Promise.resolve({
      kind: "final",
      message: "final response without compaction",
      usage: { inputTokens: 1, outputTokens: 1 }
    });
  }
}

describe("thread compact resume e2e", () => {
  it("creates session memory on compaction and rehydrates resume context", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "talon-thread-snapshot-"));
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
      provider: new ToolThenFinalProvider()
    });
    try {
      const firstOptions = createDefaultRunOptions("Preserve this goal", workspace, handle.config);
      const firstRun = await handle.service.runTask(firstOptions);
      const threadId = firstRun.task.threadId!;
      const sessionMemories = handle.service.listThreadSnapshots(threadId);
      expect(sessionMemories.length).toBeGreaterThan(0);

      handle.infrastructure.storage.threadSessionMemories.create({
        decisions: ["use existing context"],
        goal: "Preserve this goal",
        nextActions: ["verify follow-up output"],
        openLoops: ["pending file_read(tc-manual-open-loop)"],
        sessionMemoryId: "manual-latest-session-memory",
        summary: "manual resume snapshot",
        taskId: firstRun.task.taskId,
        threadId,
        trigger: "manual"
      });

      const secondRun = await handle.service.continueThread(threadId, "continue with latest state", {
        cwd: workspace
      });
      const contextDebug = handle.service.traceTaskContext(secondRun.task.taskId);
      const systemPreviews = contextDebug.contextAssembly?.systemPromptFragments.map((fragment) => fragment.preview) ?? [];
      expect(systemPreviews.some((preview) => preview.includes("[Thread Resume] Goal: Preserve this goal"))).toBe(
        true
      );
      expect(systemPreviews.some((preview) => preview.includes("Open loops: pending file_read"))).toBe(true);
      expect(systemPreviews.some((preview) => preview.includes("Decisions: use existing context"))).toBe(true);
    } finally {
      handle.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("writes final-trigger session memory for short non-compact runs and injects resume context", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "talon-thread-final-session-memory-"));
    const handle = createApplication(workspace, {
      config: {
        compact: {
          messageThreshold: 999,
          summarizer: "deterministic",
          tokenThreshold: 99999,
          toolCallThreshold: 999
        },
        databasePath: join(workspace, "runtime.db")
      },
      provider: new ImmediateFinalProvider()
    });
    try {
      const firstOptions = createDefaultRunOptions(
        "Remember this thread goal from final branch",
        workspace,
        handle.config
      );
      const firstRun = await handle.service.runTask(firstOptions);
      const threadId = firstRun.task.threadId!;
      const sessionMemories = handle.service.listThreadSnapshots(threadId);
      expect(sessionMemories.length).toBeGreaterThan(0);
      expect(sessionMemories.some((memory) => memory.trigger === "final")).toBe(true);

      const secondRun = await handle.service.continueThread(threadId, "continue with remembered goal", {
        cwd: workspace
      });
      const contextDebug = handle.service.traceTaskContext(secondRun.task.taskId);
      const systemPreviews = contextDebug.contextAssembly?.systemPromptFragments.map((fragment) => fragment.preview) ?? [];
      expect(
        systemPreviews.some((preview) =>
          preview.includes("[Thread Resume] Goal: Remember this thread goal from final branch")
        )
      ).toBe(true);
    } finally {
      handle.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });
});
