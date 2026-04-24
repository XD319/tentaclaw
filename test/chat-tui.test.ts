import { PassThrough } from "node:stream";

import { render } from "ink";
import React from "react";
import { describe, expect, it } from "vitest";

import {
  completeApprovalMessage,
  mergeTraceMessages,
  syncPendingApprovalMessages,
  useChatController,
  type ChatController
} from "../src/tui/hooks/use-chat-controller.js";
import {
  canSubmitTextInput,
  deleteCharacterAfter,
  deleteCharacterBefore,
  deletePreviousWord,
  moveCursorVertical,
  resolveApprovalShortcut
} from "../src/tui/hooks/use-text-input.js";
import {
  displayChatMessages,
  resolveApprovalMessage,
  toApprovalMessage,
  toTraceActivityMessage,
  type ChatMessage
} from "../src/tui/view-models/chat-messages.js";
import type { AgentApplicationService, AppConfig } from "../src/runtime/index.js";
import type { ApprovalRecord, RuntimeRunOptions, TaskRecord, ToolCallRecord, TraceEvent } from "../src/types/index.js";

type ControllerServiceStub = Pick<
  AgentApplicationService,
  | "listPendingApprovals"
  | "listTasks"
  | "providerStats"
  | "resolveApproval"
  | "runTask"
  | "showTask"
  | "subscribeToTaskTrace"
  | "traceTask"
>;

describe("chat tui view-models", () => {
  it("formats trace events into activity messages", () => {
    const event = createTraceEvent("tool_call_started", {
      iteration: 1,
      toolCallId: "call-00112233",
      toolName: "file_write"
    });

    const message = toTraceActivityMessage(event);
    expect(message.kind).toBe("activity");
    expect(message.text).toContain("Running file_write");
  });

  it("marks approval message as resolved", () => {
    const approval = createApprovalRecord();
    const toolCall = createToolCallRecord();
    const message = toApprovalMessage(approval, toolCall);
    const resolved = resolveApprovalMessage(message, "allow");

    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution).toBe("allow");
  });

  it("keeps agent replies visible when activity rows are collapsed", () => {
    const agent = {
      id: "agent-1",
      kind: "agent" as const,
      text: "final answer",
      timestamp: "2026-01-01T00:00:01.000Z"
    };
    const activity = toTraceActivityMessage(createTraceEvent("final_outcome", {
      errorCode: null,
      errorMessage: null,
      output: "final answer",
      status: "succeeded"
    }));

    expect(displayChatMessages([agent, activity])).toEqual([agent]);
  });

  it("keeps high-value activity messages visible in chat mode", () => {
    const activity = toTraceActivityMessage(createTraceEvent("tool_call_finished", {
      iteration: 1,
      toolCallId: "call-00112233",
      toolName: "file_write",
      summary: "wrote file",
      outputPreview: "ok"
    }));

    const visible = displayChatMessages([activity]);
    expect(visible).toHaveLength(1);
    expect(visible[0]?.kind).toBe("activity");
  });
});

describe("use-chat-controller helpers", () => {
  it("merges only unseen trace activity messages", () => {
    const first = createTraceEvent("tool_call_started", {
      iteration: 1,
      toolCallId: "call-1",
      toolName: "shell_exec"
    });
    const second = createTraceEvent("tool_call_finished", {
      iteration: 1,
      outputPreview: "ok",
      summary: "done",
      toolCallId: "call-1",
      toolName: "shell_exec"
    });

    const mergedOnce = mergeTraceMessages([], [first, second]);
    const mergedTwice = mergeTraceMessages(mergedOnce, [first, second]);

    expect(mergedOnce.length).toBe(2);
    expect(mergedTwice.length).toBe(2);
  });

  it("removes stale approval cards from the live transcript", () => {
    const approval = createApprovalRecord();
    const current = [toApprovalMessage(approval, createToolCallRecord())];
    const synced = syncPendingApprovalMessages(
      current,
      [],
      createApprovalLookupService(),
      new Set(current.map((message) => message.id))
    );

    expect(synced.some((message) => message.kind === "approval")).toBe(false);
  });

  it("replaces a completed approval card with a compact result line", () => {
    const approval = createApprovalRecord();
    const current = [toApprovalMessage(approval, createToolCallRecord())];
    const completed = completeApprovalMessage(current, approval, "allow", new Set([current[0]?.id ?? ""]));

    expect(completed.some((message) => message.kind === "approval")).toBe(false);
    expect(completed.at(-1)?.kind).toBe("approval_result");
    expect(completed.at(-1)?.id).toBe("approval-result:approval-1:allow");
  });

  it("rejects overlapping prompt submissions before they can drop replies", async () => {
    const stdout = new PassThrough();
    const config = createControllerConfig();
    const service = createStreamingControllerService();
    let submitPrompt: ChatController["submitPrompt"] | null = null;
    let messages: ChatMessage[] = [];

    function Harness(): React.ReactElement | null {
      const instance = useChatController({
        config,
        cwd: process.cwd(),
        reviewerId: "reviewer",
        service: service as AgentApplicationService
      });

      React.useEffect(() => {
        submitPrompt = instance.submitPrompt;
      }, [instance]);

      React.useEffect(() => {
        messages = instance.messages;
      }, [instance.messages]);

      return null;
    }

    const app = render(React.createElement(Harness), {
      interactive: false,
      patchConsole: false,
      stdout: stdout as unknown as NodeJS.WriteStream
    });

    try {
      await waitFor(() => submitPrompt !== null);
      if (submitPrompt === null) {
        throw new Error("submitPrompt should be initialized before the test submits prompts.");
      }
      expect(submitPrompt("one")).toBe(true);
      expect(submitPrompt("two")).toBe(false);

      await waitFor(() => messages.some((message) => message.kind === "agent"));

      expect(
        messages.filter((message) => message.kind === "user").map((message) => message.text)
      ).toEqual(["one"]);
      expect(
        messages.filter((message) => message.kind === "agent").map((message) => message.text)
      ).toEqual(["reply-one"]);
    } finally {
      app.unmount();
      await app.waitUntilExit();
    }
  });
});

describe("use-text-input helpers", () => {
  it("moves cursor up preserving preferred column", () => {
    const value = "abcd\na\nabcdef";
    const startIndex = value.length;

    const firstUp = moveCursorVertical(value, startIndex, -1, null);
    const secondUp = moveCursorVertical(value, firstUp.index, -1, firstUp.preferredColumn);

    expect(firstUp.index).toBe("abcd\na".length);
    expect(secondUp.index).toBe("abcd".length);
  });

  it("moves cursor down and clamps to shorter lines", () => {
    const value = "abcdef\nab\nabcdef";
    const start = "abc".length;
    const down = moveCursorVertical(value, start, 1, null);
    const downAgain = moveCursorVertical(value, down.index, 1, down.preferredColumn);

    expect(down.index).toBe("abcdef\nab".length);
    expect(downAgain.index).toBe("abcdef\nab\nabc".length);
  });

  it("deletes previous word with ctrl+w behavior", () => {
    const result = deletePreviousWord("hello brave world", "hello brave world".length);
    expect(result.value).toBe("hello brave ");
    expect(result.cursorIndex).toBe("hello brave ".length);
  });

  it("deletes trailing whitespace and previous word", () => {
    const result = deletePreviousWord("hello brave   ", "hello brave   ".length);
    expect(result.value).toBe("hello ");
    expect(result.cursorIndex).toBe("hello ".length);
  });

  it("deletes the character before the cursor for backspace", () => {
    const result = deleteCharacterBefore("abc", 2);
    expect(result.value).toBe("ac");
    expect(result.cursorIndex).toBe(1);
  });

  it("deletes the character after the cursor for delete", () => {
    const result = deleteCharacterAfter("abc", 1);
    expect(result.value).toBe("ac");
    expect(result.cursorIndex).toBe(1);
  });

  it("resolves approval shortcuts when input box only has whitespace", () => {
    expect(resolveApprovalShortcut("a", "   \n\t", true)).toBe("allow");
    expect(resolveApprovalShortcut("D", "  ", true)).toBe("deny");
  });

  it("ignores approval shortcuts when prompt has non-whitespace text", () => {
    expect(resolveApprovalShortcut("a", " draft", true)).toBeNull();
    expect(resolveApprovalShortcut("d", "", false)).toBeNull();
  });

  it("allows only /stop to submit while busy", () => {
    expect(canSubmitTextInput("/stop", true)).toBe(true);
    expect(canSubmitTextInput(" /stop ", true)).toBe(true);
    expect(canSubmitTextInput("hello", true)).toBe(false);
    expect(canSubmitTextInput("hello", false)).toBe(true);
    expect(canSubmitTextInput("   ", false)).toBe(false);
  });
});

function createTraceEvent(
  eventType: TraceEvent["eventType"],
  payload: Record<string, unknown>
): TraceEvent {
  return {
    actor: "agent.runtime",
    eventId: `${eventType}-id`,
    eventType,
    payload,
    sequence: 1,
    stage: "tooling",
    summary: "summary",
    taskId: "task-001",
    timestamp: "2026-01-01T00:00:00.000Z"
  } as TraceEvent;
}

function createApprovalRecord(): ApprovalRecord {
  return {
    approvalId: "approval-1",
    decidedAt: null,
    errorCode: null,
    expiresAt: "2026-01-01T01:00:00.000Z",
    policyDecisionId: "policy-1",
    reason: "Need to write files",
    requestedAt: "2026-01-01T00:00:00.000Z",
    requesterUserId: "user-1",
    reviewerId: null,
    reviewerNotes: null,
    status: "pending",
    taskId: "task-001",
    toolCallId: "call-001",
    toolName: "file_write"
  };
}

function createToolCallRecord(): ToolCallRecord {
  return {
    errorCode: null,
    errorMessage: null,
    finishedAt: null,
    input: {},
    iteration: 1,
    output: null,
    requestedAt: "2026-01-01T00:00:00.000Z",
    riskLevel: "medium",
    startedAt: null,
    status: "awaiting_approval",
    summary: null,
    taskId: "task-001",
    toolCallId: "call-001",
    toolName: "file_write"
  };
}

function createApprovalLookupService() {
  return {
    showTask: () => ({
      approvals: [],
      artifacts: [],
      task: null,
      toolCalls: [createToolCallRecord()],
      trace: []
    })
  };
}

function createControllerConfig(): AppConfig {
  return {
    allowedFetchHosts: [],
    approvalTtlMs: 60_000,
    budget: {
      pricing: {},
      task: {
        hardCostUsd: null,
        hardInputTokens: null,
        hardOutputTokens: null,
        softCostUsd: null,
        softInputTokens: null,
        softOutputTokens: null
      },
      thread: {
        hardCostUsd: null,
        hardInputTokens: null,
        hardOutputTokens: null,
        softCostUsd: null,
        softInputTokens: null,
        softOutputTokens: null
      }
    },
    compact: {
      messageThreshold: 20,
      summarizer: "deterministic",
      tokenThreshold: 8_000,
      toolCallThreshold: 10
    },
    databasePath: ":memory:",
    defaultMaxIterations: 4,
    defaultProfileId: "executor",
    defaultTimeoutMs: 10_000,
    promotion: {
      enabled: false,
      maxHumanJudgmentWeight: 0,
      minStability: 0,
      minSuccessCount: 0,
      minSuccessRate: 0,
      riskDenyKeywords: []
    },
    provider: {
      apiKey: null,
      baseUrl: null,
      builtinProviderName: "mock",
      configPath: "memory",
      configSource: "defaults",
      displayName: "Mock Provider",
      family: "mock",
      maxRetries: 0,
      model: "mock",
      name: "mock",
      timeoutMs: 10_000,
      transport: "mock"
    },
    recall: {
      budgetRatio: 0,
      enabled: false,
      maxCandidatesPerScope: 0
    },
    routing: {
      helpers: {
        classify: null,
        recallRank: null,
        summarize: null
      },
      mode: "balanced",
      providers: {}
    },
    runtimeConfigPath: "memory",
    runtimeConfigSource: "defaults",
    runtimeVersion: "test",
    sandbox: {
      configPath: null,
      configSource: "defaults",
      dockerImage: null,
      mode: "local",
      network: "disabled",
      profileName: null,
      readRoots: [process.cwd()],
      shellAllowlist: [],
      workspaceRoot: process.cwd(),
      writeRoots: [process.cwd()]
    },
    tokenBudget: {
      inputLimit: 8_000,
      outputLimit: 4_000,
      reservedOutput: 500,
      usedCostUsd: 0,
      usedInput: 0,
      usedOutput: 0
    },
    workflow: {
      failureGuidedRetry: {
        enabled: false,
        maxRepairAttempts: 0
      },
      repoMap: {
        enabled: false
      },
      testCommands: []
    },
    workspaceRoot: process.cwd()
  };
}

function createStreamingControllerService(): ControllerServiceStub {
  const tasks = new Map<string, TaskRecord>();

  return {
    async runTask(options: RuntimeRunOptions) {
      const task = createControllerTask(options);
      tasks.set(task.taskId, task);

      if (options.taskInput === "one") {
        await delay(5);
        options.onAssistantTextDelta?.("partial-one");
        await delay(20);
        task.status = "succeeded";
        task.finalOutput = "reply-one";
        return {
          output: "reply-one",
          task
        };
      }

      await delay(10);
      options.onAssistantTextDelta?.("partial-two");
      await delay(10);
      task.status = "succeeded";
      task.finalOutput = "reply-two";
      return {
        output: "reply-two",
        task
      };
    },
    listPendingApprovals() {
      return [];
    },
    listTasks() {
      return [...tasks.values()];
    },
    providerStats() {
      return null;
    },
    resolveApproval() {
      throw new Error("resolveApproval should not be called in this test.");
    },
    showTask(taskId: string) {
      return {
        approvals: [],
        artifacts: [],
        inboxItems: [],
        scheduleRuns: [],
        task: tasks.get(taskId) ?? null,
        toolCalls: [],
        trace: []
      };
    },
    subscribeToTaskTrace() {
      return () => {};
    },
    traceTask() {
      return [];
    }
  };
}

function createControllerTask(options: RuntimeRunOptions): TaskRecord {
  const timestamp = new Date().toISOString();
  return {
    agentProfileId: options.agentProfileId,
    createdAt: timestamp,
    currentIteration: 0,
    cwd: options.cwd,
    errorCode: null,
    errorMessage: null,
    finalOutput: null,
    finishedAt: null,
    input: options.taskInput,
    maxIterations: options.maxIterations,
    metadata: options.metadata ?? {},
    providerName: "mock",
    requesterUserId: options.userId,
    startedAt: timestamp,
    status: "running",
    taskId: options.taskId ?? "task",
    threadId: options.threadId ?? null,
    tokenBudget: options.tokenBudget,
    updatedAt: timestamp
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for predicate.");
    }
    await delay(10);
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
