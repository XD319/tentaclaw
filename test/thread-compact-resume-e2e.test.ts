import { join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createApplication, createDefaultRunOptions } from "../src/runtime/index.js";
import type { LocalPolicyConfig, Provider, ProviderInput, ProviderResponse } from "../src/types/index.js";

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
              path: "."
            },
            reason: "Need project context",
            toolCallId: "tc-read-1",
            toolName: "glob"
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

class LongCodingCompactClarifyProvider implements Provider {
  public readonly name = "long-coding-compact-clarify";
  public sawCompactBeforeClarify = false;
  public sawCompactAfterResume = false;
  private callCount = 0;

  public generate(input: ProviderInput): Promise<ProviderResponse> {
    this.callCount += 1;
    const sawSessionSummary = input.messages.some((message) => message.content.includes("Session handoff:"));
    if (this.callCount === 1) {
      return Promise.resolve({
        kind: "tool_calls",
        message: "Inspect implementation files.",
        toolCalls: ["alpha.ts", "beta.ts", "gamma.ts"].map((path, index) => ({
          input: {
            path
          },
          reason: `Inspect ${path}.`,
          toolCallId: `long-read-${index}`,
          toolName: "read_file"
        })),
        usage: { inputTokens: 10, outputTokens: 5 }
      });
    }

    if (this.callCount === 2) {
      this.sawCompactBeforeClarify = sawSessionSummary;
      return Promise.resolve({
        kind: "tool_calls",
        message: "Need implementation direction.",
        toolCalls: [
          {
            input: {
              allowCustomAnswer: true,
              options: [
                { id: "strict", label: "Strict" },
                { id: "loose", label: "Loose" }
              ],
              question: "Which implementation mode should be written?"
            },
            reason: "Pause the long coding task for a user decision.",
            toolCallId: "long-clarify",
            toolName: "clarify"
          }
        ],
        usage: { inputTokens: 10, outputTokens: 5 }
      });
    }

    if (this.callCount === 3) {
      this.sawCompactAfterResume = sawSessionSummary;
      return Promise.resolve({
        kind: "tool_calls",
        message: "Write the resumed implementation.",
        toolCalls: [
          {
            input: {
              content: "mode=strict\n",
              path: "result.txt"
            },
            reason: "Persist the implementation choice after resume.",
            toolCallId: "long-write",
            toolName: "write_file"
          }
        ],
        usage: { inputTokens: 10, outputTokens: 5 }
      });
    }

    return Promise.resolve({
      kind: "final",
      message: "long coding task resumed and completed",
      usage: { inputTokens: 5, outputTokens: 5 }
    });
  }
}

const LONG_CODING_POLICY_CONFIG: LocalPolicyConfig = {
  defaultEffect: "deny",
  rules: [
    {
      description: "Allow workspace file reads.",
      effect: "allow",
      id: "allow-workspace-read",
      match: {
        capabilities: ["filesystem.read"],
        pathScopes: ["workspace"]
      },
      priority: 100
    },
    {
      description: "Allow workspace file writes.",
      effect: "allow",
      id: "allow-workspace-write",
      match: {
        capabilities: ["filesystem.write"],
        pathScopes: ["workspace"]
      },
      priority: 90
    },
    {
      description: "Allow interactive clarification.",
      effect: "allow",
      id: "allow-ask-user",
      match: {
        capabilities: ["interaction.ask_user"]
      },
      priority: 80
    }
  ],
  source: "local"
};

describe("session compact resume e2e", () => {
  it("creates session memory on compaction and rehydrates resume context", async () => {
    const workspace = createSessionWorkspace("talon-session-snapshot-");
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
      const sessionId = firstRun.task.sessionId!;
      const sessionMemories = handle.service.listSessionSummaries(sessionId);
      expect(sessionMemories.length).toBeGreaterThan(0);

      handle.infrastructure.storage.sessionSummaries.create({
        decisions: ["use existing context"],
        goal: "Preserve this goal",
        nextActions: ["verify follow-up output"],
        openLoops: ["pending read_file(tc-manual-open-loop)"],
        sessionSummaryId: "manual-latest-session-memory",
        summary: "manual resume snapshot",
        taskId: firstRun.task.taskId,
        sessionId,
        trigger: "manual"
      });

      const secondRun = await handle.service.continueSession(sessionId, "continue with latest state", {
        cwd: workspace
      });
      const contextDebug = handle.service.traceTaskContext(secondRun.task.taskId);
      const systemPreviews = contextDebug.contextAssembly?.systemPromptFragments.map((fragment) => fragment.preview) ?? [];
      expect(systemPreviews.some((preview) => preview.includes("KnownActiveGoal: Preserve this goal"))).toBe(true);
      expect(systemPreviews.some((preview) => preview.includes("KnownOpenLoops: pending read_file"))).toBe(true);
      expect(systemPreviews.some((preview) => preview.includes("KnownDecisions: use existing context"))).toBe(true);
      const memoryRecall = contextDebug.contextAssembly?.memoryRecallFragments ?? [];
      expect(memoryRecall.some((fragment) => fragment.label === "Active goal")).toBe(true);
      expect(memoryRecall.some((fragment) => fragment.label === "Session decisions")).toBe(true);
    } finally {
      handle.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("writes final-trigger session memory for short non-compact runs and injects resume context", async () => {
    const workspace = createSessionWorkspace("talon-session-final-session-memory-");
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
        "Remember this session goal from final branch",
        workspace,
        handle.config
      );
      const firstRun = await handle.service.runTask(firstOptions);
      const sessionId = firstRun.task.sessionId!;
      const sessionMemories = handle.service.listSessionSummaries(sessionId);
      expect(sessionMemories.length).toBeGreaterThan(0);
      expect(sessionMemories.some((memory) => memory.trigger === "final")).toBe(true);
      expect(handle.service.showSession(sessionId).state.pendingDecision).toBeNull();

      const secondRun = await handle.service.continueSession(sessionId, "continue with remembered goal", {
        cwd: workspace
      });
      expect(handle.service.listSessionSummaries(sessionId)[0]?.goal).toBe("continue with remembered goal");
      const contextDebug = handle.service.traceTaskContext(secondRun.task.taskId);
      const systemPreviews = contextDebug.contextAssembly?.systemPromptFragments.map((fragment) => fragment.preview) ?? [];
      expect(
        systemPreviews.some(
          (preview) =>
            preview.includes("KnownActiveGoal: continue with remembered goal") ||
            preview.includes("KnownCurrentDirective:")
        )
      ).toBe(true);
    } finally {
      handle.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("writes resume hygiene summary without deleting session messages", async () => {
    const workspace = createSessionWorkspace("talon-session-hygiene-");
    const handle = createApplication(workspace, {
      config: {
        compact: {
          hygieneThresholdRatio: 0.85,
          summarizer: "deterministic"
        },
        databasePath: join(workspace, "runtime.db"),
        tokenBudget: {
          inputLimit: 1_000,
          outputLimit: 400,
          reservedOutput: 50,
          usedInput: 0,
          usedOutput: 0
        }
      },
      provider: new ImmediateFinalProvider()
    });
    try {
      const session = handle.service.createSession({
        agentProfileId: "executor",
        cwd: workspace,
        ownerUserId: "test-user",
        title: "Large resume session"
      });
      const largeText = "important context ".repeat(400);
      handle.infrastructure.storage.sessionMessages.append({
        kind: "user",
        messageId: "hygiene-user-1",
        payload: { text: largeText },
        sessionId: session.sessionId
      });
      handle.infrastructure.storage.sessionMessages.append({
        kind: "agent",
        messageId: "hygiene-agent-1",
        payload: { text: "captured state" },
        sessionId: session.sessionId
      });
      const beforeCount = handle.infrastructure.storage.sessionMessages.countBySessionId(session.sessionId);

      const run = await handle.service.continueSession(session.sessionId, "continue", { cwd: workspace });
      const afterCount = handle.infrastructure.storage.sessionMessages.countBySessionId(session.sessionId);
      const summaries = handle.service.listSessionSummaries(session.sessionId);
      const lineage = handle.infrastructure.storage.sessionLineage.listBySessionId(session.sessionId);

      expect(run.task.status).toBe("succeeded");
      expect(afterCount).toBeGreaterThanOrEqual(beforeCount);
      expect(summaries.some((summary) => summary.trigger === "resume")).toBe(true);
      expect(lineage.some((event) => event.eventType === "compress" && event.payload.hygiene === true)).toBe(true);
      expect(
        handle.service.traceTaskContext(run.task.taskId).contextAssembly?.systemPromptFragments.some((fragment) =>
          fragment.preview.includes("KnownActiveGoal")
        )
      ).toBe(true);
    } finally {
      handle.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("preserves compacted long coding context across clarification resume", async () => {
    const workspace = createSessionWorkspace("talon-long-coding-resume-");
    writeFileSync(join(workspace, "alpha.ts"), "export const alpha = true;\n", "utf8");
    writeFileSync(join(workspace, "beta.ts"), "export const beta = true;\n", "utf8");
    writeFileSync(join(workspace, "gamma.ts"), "export const gamma = true;\n", "utf8");
    const provider = new LongCodingCompactClarifyProvider();
    const handle = createApplication(workspace, {
      config: {
        compact: {
          iterationThreshold: 999,
          messageThreshold: 999,
          minTokenPressureRatio: 0,
          summarizer: "deterministic",
          tokenThreshold: 999_999,
          toolCallThreshold: 2
        },
        databasePath: join(workspace, "runtime.db")
      },
      policyConfig: LONG_CODING_POLICY_CONFIG,
      provider
    });

    try {
      const options = createDefaultRunOptions("implement the long coding change", workspace, handle.config);
      options.metadata = { interactivePromptMode: "tui", sessionApprovalFingerprints: [] };
      const initial = await handle.service.runTask(options);

      expect(initial.task.status).toBe("waiting_clarification");
      expect(provider.sawCompactBeforeClarify).toBe(true);
      expect(handle.service.traceTask(initial.task.taskId).some((event) => event.eventType === "session_compacted")).toBe(true);

      const prompt = handle.service.listPendingClarifyPrompts()[0];
      expect(prompt?.question).toBe("Which implementation mode should be written?");

      const resumed = await handle.service.answerClarifyPrompt(prompt?.promptId ?? "", "reviewer", {
        answerOptionId: "strict"
      });

      expect(resumed.task.status).toBe("succeeded");
      expect(resumed.output).toContain("resumed and completed");
      expect(provider.sawCompactAfterResume).toBe(true);
      expect(readFileSyncUtf8(join(workspace, "result.txt"))).toBe("mode=strict\n");
    } finally {
      handle.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });
});

function createSessionWorkspace(prefix: string): string {
  const tempRoot = join(process.cwd(), ".tmp-tests");
  mkdirSync(tempRoot, { recursive: true });
  return mkdtempSync(join(tempRoot, prefix));
}

function readFileSyncUtf8(path: string): string {
  return readFileSync(path, "utf8");
}
