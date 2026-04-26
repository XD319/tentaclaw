import { describe, expect, it } from "vitest";

import { ContextCompactor } from "../src/runtime/context/context-compactor.js";
import type { ProviderToolDescriptor, TaskRecord } from "../src/types/index.js";

describe("context compactor", () => {
  it("extracts goal, decisions, open loops, actions and capabilities", () => {
    const compactor = new ContextCompactor();
    const task: TaskRecord = {
      agentProfileId: "executor",
      createdAt: "2026-01-01T00:00:00.000Z",
      currentIteration: 1,
      cwd: "/tmp/workspace",
      errorCode: null,
      errorMessage: null,
      finalOutput: null,
      finishedAt: null,
      input: "Primary objective",
      maxIterations: 8,
      metadata: {},
      providerName: "mock",
      requesterUserId: "u1",
      startedAt: "2026-01-01T00:00:01.000Z",
      status: "running",
      taskId: "task-1",
      threadId: "thread-1",
      tokenBudget: { inputLimit: 1000, outputLimit: 500, reservedOutput: 100, usedInput: 0, usedOutput: 0 },
      updatedAt: "2026-01-01T00:00:01.000Z"
    };
    const availableTools: ProviderToolDescriptor[] = [
      {
        capability: "shell.execute",
        description: "shell",
        inputSchema: { type: "object", properties: {}, required: [] },
        name: "Shell",
        privacyLevel: "internal",
        riskLevel: "medium"
      }
    ];

    const sessionMemory = compactor.buildSessionMemory({
      availableTools,
      compact: {
        maxMessagesBeforeCompact: 6,
        messages: [
          {
            content: "My long-running objective and email me at demo@example.com with token=ghp_abcdefghijklmnopqrstuvwxyz",
            role: "user"
          },
          {
            content: "I will run tools",
            role: "assistant",
            toolCalls: [{ toolCallId: "tc-1", toolName: "Shell" }]
          },
          {
            content: "approval denied by policy",
            role: "tool",
            toolCallId: "tc-2",
            toolName: "Shell"
          },
          { content: "Next I should execute pending Shell command", role: "assistant" }
        ],
        reason: "message_count",
        sessionScopeKey: "task-1",
        taskId: "task-1"
      },
      task
    });

    expect(sessionMemory.goal).toContain("My long-running objective");
    expect(sessionMemory.decisions.join(" ")).toContain("Next I should execute pending Shell command");
    expect(sessionMemory.openLoops.join(" ")).toContain("tc-1");
    expect(sessionMemory.nextActions.length).toBeGreaterThan(0);
    expect(sessionMemory.summary).toContain("completedWork=");
    expect(sessionMemory.summary).toContain("filesTouched=");
    expect(sessionMemory.summary).toContain("commandsRun=");
    expect(sessionMemory.summary).toContain("blockers=");
    expect(sessionMemory.summary).toContain("[REDACTED_EMAIL]");
    expect(sessionMemory.summary).toContain("token=[REDACTED]");
    expect(
      Array.isArray(sessionMemory.metadata?.toolCapabilitySummary) &&
        sessionMemory.metadata.toolCapabilitySummary.includes("Shell")
    ).toBe(true);
  });
});
