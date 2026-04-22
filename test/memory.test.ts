import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { formatTraceContextDebug } from "../src/cli/formatters";
import { MemoryPlane } from "../src/memory/memory-plane";
import { ContextPolicy } from "../src/policy/context-policy";
import { ExecutionContextAssembler } from "../src/runtime/context-assembler";
import { createApplication, createDefaultRunOptions } from "../src/runtime";
import { StorageManager } from "../src/storage/database";
import { TraceService } from "../src/tracing/trace-service";
import type { Provider, ProviderInput, ProviderResponse, TaskRecord } from "../src/types";

class ScriptedProvider implements Provider {
  public readonly name = "scripted-provider";

  public constructor(
    private readonly responder: (input: ProviderInput) => Promise<ProviderResponse> | ProviderResponse
  ) {}

  public async generate(input: ProviderInput): Promise<ProviderResponse> {
    return this.responder(input);
  }
}

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined) {
      await fs.rm(tempPath, { force: true, recursive: true });
    }
  }
});

describe("Phase 3 memory plane", () => {
  it("compacts long sessions into a summary memory", async () => {
    const { memoryPlane, close } = createMemoryHarness();

    try {
      const result = await memoryPlane.compactSession({
        maxMessagesBeforeCompact: 4,
        messages: [
          { content: "system prompt", role: "system" },
          { content: "task goal", role: "user" },
          { content: "plan step 1", role: "assistant" },
          { content: "tool output A", role: "tool" },
          { content: "plan step 2", role: "assistant" },
          { content: "tool output B", role: "tool" }
        ],
        sessionScopeKey: "session-1",
        taskId: "task-1"
      });

      expect(result.triggered).toBe(true);
      expect(result.summaryMemory?.sourceType).toBe("session_compact");
      expect(result.replacementMessages[0]?.content).toContain("Session summary");
    } finally {
      close();
    }
  });

  it("supports token and tool-call compact triggers", async () => {
    const { memoryPlane, close } = createMemoryHarness();
    try {
      const tokenResult = await memoryPlane.compactSession({
        maxMessagesBeforeCompact: 100,
        messages: [
          { content: "system prompt", role: "system" },
          { content: "task goal", role: "user" }
        ],
        sessionScopeKey: "session-2",
        taskId: "task-2",
        tokenEstimate: 4000,
        tokenThreshold: 100
      });
      expect(tokenResult.triggered).toBe(true);
      expect(tokenResult.reason).toBe("token_budget");

      const toolResult = await memoryPlane.compactSession({
        maxMessagesBeforeCompact: 100,
        messages: [
          { content: "system prompt", role: "system" },
          { content: "task goal", role: "user" }
        ],
        sessionScopeKey: "session-3",
        taskId: "task-3",
        toolCallCount: 20,
        toolCallThreshold: 10
      });
      expect(toolResult.triggered).toBe(true);
      expect(toolResult.reason).toBe("tool_call_count");
    } finally {
      close();
    }
  });

  it("returns explainable recall results with typed source metadata", () => {
    const { memoryPlane, close } = createMemoryHarness();

    try {
      memoryPlane.writeMemory({
        confidence: 0.92,
        content: "Use pnpm and vitest for runtime verification.",
        expiresAt: null,
        keywords: ["pnpm", "vitest", "runtime"],
        privacyLevel: "internal",
        retentionPolicy: {
          kind: "project",
          reason: "Project build guidance",
          ttlDays: 30
        },
        scope: "project",
        scopeKey: "workspace-a",
        source: {
          label: "Project build guide",
          sourceType: "system",
          taskId: null,
          toolCallId: null,
          traceEventId: null
        },
        status: "verified",
        summary: "Builds use pnpm and vitest.",
        title: "Build guide"
      });

      const task = createTask({
        cwd: "workspace-a",
        input: "run vitest in this runtime project",
        taskId: "task-recall"
      });
      const result = memoryPlane.buildContext(task);

      expect(result.recall.candidates[0]?.explanation).toContain("source=Project build guide");
      expect(result.fragments[0]?.sourceType).toBe("system");
      expect(result.fragments[0]?.text).toContain("Build guide");
    } finally {
      close();
    }
  });

  it("downgrades stale memory during recall ordering", () => {
    const { memoryPlane, close } = createMemoryHarness();

    try {
      memoryPlane.writeMemory({
        confidence: 0.98,
        content: "Old memory for runtime verification.",
        expiresAt: "2020-01-01T00:00:00.000Z",
        keywords: ["runtime", "verification"],
        privacyLevel: "internal",
        retentionPolicy: {
          kind: "project",
          reason: "Old guidance",
          ttlDays: 1
        },
        scope: "project",
        scopeKey: "workspace-stale",
        source: {
          label: "Outdated guide",
          sourceType: "system",
          taskId: null,
          toolCallId: null,
          traceEventId: null
        },
        status: "verified",
        summary: "Old guide",
        title: "Old guide"
      });
      memoryPlane.writeMemory({
        confidence: 0.7,
        content: "Fresh memory for runtime verification.",
        expiresAt: null,
        keywords: ["runtime", "verification"],
        privacyLevel: "internal",
        retentionPolicy: {
          kind: "project",
          reason: "Fresh guidance",
          ttlDays: 30
        },
        scope: "project",
        scopeKey: "workspace-stale",
        source: {
          label: "Fresh guide",
          sourceType: "system",
          taskId: null,
          toolCallId: null,
          traceEventId: null
        },
        status: "verified",
        summary: "Fresh guide",
        title: "Fresh guide"
      });

      const result = memoryPlane.buildContext(
        createTask({
          cwd: "workspace-stale",
          input: "need runtime verification guidance",
          taskId: "task-stale"
        })
      );

      expect(memoryPlane.list({ includeExpired: true, scope: "project", scopeKey: "workspace-stale" }).some((memory) => memory.status === "stale")).toBe(true);
      expect(result.recall.candidates[0]?.memory.title).toBe("Fresh guide");
    } finally {
      close();
    }
  });

  it("marks conflicting memories instead of overwriting them", () => {
    const { memoryPlane, close } = createMemoryHarness();

    try {
      const first = memoryPlane.writeMemory({
        confidence: 0.8,
        content: "Runtime uses pnpm for package management.",
        expiresAt: null,
        keywords: ["runtime", "pnpm", "package"],
        privacyLevel: "internal",
        retentionPolicy: {
          kind: "project",
          reason: "Tooling rule",
          ttlDays: 30
        },
        scope: "project",
        scopeKey: "workspace-conflict",
        source: {
          label: "Tooling note A",
          sourceType: "system",
          taskId: null,
          toolCallId: null,
          traceEventId: null
        },
        status: "verified",
        summary: "Project uses pnpm.",
        title: "Package manager"
      });
      const second = memoryPlane.writeMemory({
        confidence: 0.8,
        content: "Runtime uses npm for package management.",
        expiresAt: null,
        keywords: ["runtime", "pnpm", "package"],
        privacyLevel: "internal",
        retentionPolicy: {
          kind: "project",
          reason: "Tooling rule",
          ttlDays: 30
        },
        scope: "project",
        scopeKey: "workspace-conflict",
        source: {
          label: "Tooling note B",
          sourceType: "system",
          taskId: null,
          toolCallId: null,
          traceEventId: null
        },
        status: "verified",
        summary: "Project uses npm.",
        title: "Package manager"
      });

      expect(first).not.toBeNull();
      expect(second?.conflictsWith.length).toBeGreaterThan(0);
      const refreshedFirst = memoryPlane.list({
        includeExpired: true,
        includeRejected: true,
        scope: "project",
        scopeKey: "workspace-conflict"
      }).find((memory) => memory.memoryId === first?.memoryId);
      expect(refreshedFirst?.conflictsWith).toContain(second?.memoryId);
    } finally {
      close();
    }
  });

  it("blocks restricted content from automatic long-term memory", () => {
    const { memoryPlane, close } = createMemoryHarness();

    try {
      const persisted = memoryPlane.writeMemory({
        confidence: 0.75,
        content: "secret token=abc123",
        expiresAt: null,
        keywords: ["secret", "token"],
        privacyLevel: "restricted",
        retentionPolicy: {
          kind: "project",
          reason: "Should be blocked",
          ttlDays: 30
        },
        scope: "project",
        scopeKey: "workspace-private",
        source: {
          label: "Restricted shell output",
          sourceType: "tool_output",
          taskId: "task-private",
          toolCallId: "tool-private",
          traceEventId: null
        },
        status: "candidate",
        summary: "secret token",
        title: "Restricted data"
      });

      expect(persisted).toBeNull();
      expect(memoryPlane.list({ includeExpired: true, includeRejected: true }).length).toBe(0);
    } finally {
      close();
    }
  });

  it("records recall provenance in task trace", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      },
      provider: new ScriptedProvider(() => ({
        kind: "final",
        message: "Use vitest for runtime verification in this workspace.",
        usage: {
          inputTokens: 12,
          outputTokens: 6
        }
      }))
    });

    try {
      await handle.service.runTask(
        createDefaultRunOptions("remember vitest guidance", workspaceRoot, handle.config)
      );
      const second = await handle.service.runTask(
        createDefaultRunOptions("find runtime verification guidance", workspaceRoot, handle.config)
      );
      const trace = handle.service.traceTask(second.task.taskId);
      const recallEvent = trace.find((event) => event.eventType === "memory_recalled");

      expect(recallEvent).toBeDefined();
      expect(handle.infrastructure.storage.memories.list({
        includeExpired: true,
        includeRejected: true
      }).some((memory) => memory.sourceType === "final_output")).toBe(false);
    } finally {
      handle.close();
    }
  });

  it("emits structured context and reviewer debug output for trace context views", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.writeFile(join(workspaceRoot, "README.md"), "runtime context debug file");
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      },
      provider: new ScriptedProvider((input) => {
        const hasToolFeedback = input.messages.some((message) => message.role === "tool");
        if (!hasToolFeedback) {
          return {
            kind: "tool_calls",
            message: "Read README first.",
            toolCalls: [
              {
                input: {
                  action: "read_file",
                  path: "README.md"
                },
                reason: "Need workspace context",
                toolCallId: "tool-readme",
                toolName: "file_read"
              }
            ],
            usage: {
              inputTokens: 10,
              outputTokens: 4
            }
          };
        }

        return {
          kind: "final",
          message: "Risk found after reading README. Stop and block execution.",
          usage: {
            inputTokens: 12,
            outputTokens: 5
          }
        };
      })
    });

    try {
      const options = createDefaultRunOptions("inspect context assembly", workspaceRoot, handle.config);
      options.agentProfileId = "reviewer";
      const result = await handle.service.runTask(options);
      const report = handle.service.traceTaskContext(result.task.taskId);
      const formatted = formatTraceContextDebug(report);
      const parsed = JSON.parse(formatted) as {
        contextAssembly: {
          originalTaskInput: { sourceType: string };
          systemPromptFragments: unknown[];
          toolResultFragments: unknown[];
        };
        reviewerTrace: {
          continuationBlocked: boolean;
          riskDetected: boolean;
        };
      };

      expect(parsed.contextAssembly.originalTaskInput.sourceType).toBe("user_input");
      expect(parsed.contextAssembly.systemPromptFragments.length).toBeGreaterThan(0);
      expect(parsed.contextAssembly.toolResultFragments.length).toBeGreaterThan(0);
      expect(parsed.reviewerTrace.riskDetected).toBe(true);
      expect(parsed.reviewerTrace.continuationBlocked).toBe(true);
    } finally {
      handle.close();
    }
  });

  it("includes recall explanations, confidence, status, and filter reasons", () => {
    const { memoryPlane, storage, close } = createMemoryHarness();

    try {
      storage.memories.create({
        confidence: 0.61,
        content: "secret token=abc123",
        expiresAt: null,
        keywords: ["secret", "token"],
        privacyLevel: "restricted",
        retentionPolicy: {
          kind: "project",
          reason: "Sensitive project note",
          ttlDays: 30
        },
        scope: "project",
        scopeKey: "workspace-private",
        source: {
          label: "Restricted note",
          sourceType: "tool_output",
          taskId: "task-private",
          toolCallId: "tool-private",
          traceEventId: null
        },
        status: "stale",
        summary: "secret token",
        title: "Restricted data"
      });

      memoryPlane.buildContext(
        createTask({
          cwd: "workspace-private",
          input: "find secret token",
          taskId: "task-private"
        })
      );

      const recallEvent = storage.traces
        .listByTaskId("task-private")
        .find((event) => event.eventType === "memory_recalled");

      expect(recallEvent).toBeDefined();
      expect(recallEvent?.payload.entries[0]?.explanation).toContain("privacy=restricted");
      expect(recallEvent?.payload.entries[0]?.confidence).toBe(0.61);
      expect(recallEvent?.payload.entries[0]?.status).toBe("stale");
      expect(recallEvent?.payload.entries[0]?.downrankReasons).toContain("stale_memory");
      expect(recallEvent?.payload.entries[0]?.filterReasonCode).toBe("filtered_by_privacy");
    } finally {
      close();
    }
  });

  it("redacts restricted snippets in the debug context view", () => {
    const assembler = new ExecutionContextAssembler();
    const assembled = assembler.assemble({
      availableTools: [],
      iteration: 2,
      memoryContext: [],
      messages: [
        {
          content: "system prompt",
          metadata: {
            privacyLevel: "internal",
            retentionKind: "session"
          },
          role: "system"
        },
        {
          content: "investigate secret token=abc123",
          role: "user"
        },
        {
          content: "{\"stdout\":\"secret token=abc123\"}",
          metadata: {
            privacyLevel: "restricted",
            retentionKind: "session"
          },
          role: "tool",
          toolCallId: "tool-secret",
          toolName: "shell"
        }
      ],
      signal: new AbortController().signal,
      task: createTask({
        cwd: "workspace-redaction",
        input: "investigate secret token=abc123",
        taskId: "task-redaction"
      }),
      tokenBudget: {
        inputLimit: 8_000,
        outputLimit: 2_000,
        reservedOutput: 500,
        usedInput: 0,
        usedOutput: 0
      }
    });

    expect(assembled.debug.toolResultFragments[0]?.preview).toBe("[REDACTED: restricted content]");
    expect(assembled.debug.originalTaskInput.preview).not.toContain("token=abc123");
  });

});

function createMemoryHarness() {
  const storage = new StorageManager({
    databasePath: ":memory:"
  });
  const traceService = new TraceService(storage.traces);
  const memoryPlane = new MemoryPlane({
    contextPolicy: new ContextPolicy(),
    memoryRepository: storage.memories,
    memorySnapshotRepository: storage.memorySnapshots,
    traceService
  });

  return {
    close: () => storage.close(),
    memoryPlane,
    storage
  };
}

function createTask(overrides: Partial<TaskRecord> & Pick<TaskRecord, "taskId" | "input" | "cwd">): TaskRecord {
  const now = new Date().toISOString();
  return {
    agentProfileId: "executor",
    createdAt: now,
    currentIteration: 0,
    cwd: overrides.cwd,
    errorCode: null,
    errorMessage: null,
    finalOutput: null,
    finishedAt: null,
    input: overrides.input,
    maxIterations: 8,
    metadata: {},
    providerName: "scripted-provider",
    requesterUserId: "local-user",
    startedAt: now,
    status: "running",
    taskId: overrides.taskId,
    tokenBudget: {
      inputLimit: 8_000,
      outputLimit: 2_000,
      reservedOutput: 500,
      usedInput: 0,
      usedOutput: 0
    },
    updatedAt: now,
    ...overrides
  };
}

async function createTempWorkspace(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-phase3-"));
  tempPaths.push(workspaceRoot);
  return workspaceRoot;
}
