import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { CompactTriggerPolicy } from "../src/memory/compact-policy.js";
import { buildCapabilityDeclaration } from "../src/memory/capability-declaration-builder.js";
import { createApplication, createDefaultRunOptions } from "../src/runtime/index.js";
import {
  DEDUPLICATABLE_CAPABILITIES,
  stableStringify,
  toolCallSignature
} from "../src/runtime/kernel-support.js";
import type { LocalPolicyConfig, Provider, ProviderInput, ProviderResponse } from "../src/types/index.js";

class ScriptedProvider implements Provider {
  public readonly name = "loop-discipline-provider";

  public constructor(
    private readonly responder: (input: ProviderInput) => Promise<ProviderResponse> | ProviderResponse
  ) {}

  public async generate(input: ProviderInput): Promise<ProviderResponse> {
    return this.responder(input);
  }
}

const SHELL_ALLOW_POLICY: LocalPolicyConfig = {
  defaultEffect: "deny",
  rules: [
    {
      description: "Allow shell in workspace for loop discipline tests.",
      effect: "allow",
      id: "test-shell-allow",
      match: {
        capabilities: ["shell.execute"],
        pathScopes: ["workspace", "write_root"]
      },
      priority: 80
    },
    {
      description: "Allow file reads in workspace.",
      effect: "allow",
      id: "test-file-read-allow",
      match: {
        capabilities: ["filesystem.read"],
        pathScopes: ["workspace", "write_root"]
      },
      priority: 70
    }
  ],
  source: "local"
};

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (path !== undefined) {
      await fs.rm(path, { force: true, recursive: true });
    }
  }
});

describe("loop discipline", () => {
  it("includes loop discipline directives in capability declaration", () => {
    const text = buildCapabilityDeclaration({
      agentProfileId: "executor",
      availableTools: [],
      skillContext: []
    });

    expect(text).toContain("loop discipline");
    expect(text).toContain("identical arguments");
    expect(text).toContain("todo items");
    expect(text).toContain("instead of repeating the same discovery work");
  });

  it("builds stable tool call signatures regardless of key order", () => {
    expect(toolCallSignature("read_file", { a: 1, b: 2 })).toBe(
      toolCallSignature("read_file", { b: 2, a: 1 })
    );
    expect(stableStringify({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
  });

  it("does not treat shell.execute as deduplicatable", () => {
    expect(DEDUPLICATABLE_CAPABILITIES.has("shell.execute")).toBe(false);
    expect(DEDUPLICATABLE_CAPABILITIES.has("filesystem.read")).toBe(true);
  });

  it("triggers compaction when iteration threshold is reached", () => {
    const policy = new CompactTriggerPolicy();
    const decision = policy.shouldCompact({
      iteration: 8,
      iterationThreshold: 8,
      maxMessagesBeforeCompact: 999,
      messages: [{ content: "x", role: "user" }],
      sessionScopeKey: "s1",
      taskId: "t1",
      tokenEstimate: 0,
      tokenThreshold: Number.POSITIVE_INFINITY,
      toolCallCount: 0,
      toolCallThreshold: Number.POSITIVE_INFINITY
    });

    expect(decision.triggered).toBe(true);
    expect(decision.reason).toBe("iteration_count");

    const below = policy.shouldCompact({
      iteration: 7,
      iterationThreshold: 8,
      maxMessagesBeforeCompact: 999,
      messages: [{ content: "x", role: "user" }],
      sessionScopeKey: "s1",
      taskId: "t1",
      tokenEstimate: 0,
      tokenThreshold: Number.POSITIVE_INFINITY,
      toolCallCount: 0,
      toolCallThreshold: Number.POSITIVE_INFINITY
    });
    expect(below.triggered).toBe(false);
  });

  it("annotates duplicate read_file tool results", async () => {
    const workspace = await fs.mkdtemp(join(tmpdir(), "talon-loop-dedup-"));
    tempPaths.push(workspace);
    await fs.writeFile(join(workspace, "target.txt"), "payload", "utf8");

    let sawDuplicateNote = false;
    const handle = createApplication(workspace, {
      config: { databasePath: join(workspace, "runtime.db") },
      provider: new ScriptedProvider((input) => {
        const toolMessages = input.messages.filter((message) => message.role === "tool");
        if (toolMessages.some((message) => message.content.includes("NOTE: duplicate"))) {
          sawDuplicateNote = true;
        }

        if (toolMessages.length === 0) {
          return {
            kind: "tool_calls",
            message: "",
            toolCalls: [
              {
                input: { path: join(workspace, "target.txt") },
                reason: "Read target file.",
                toolCallId: "read-1",
                toolName: "read_file"
              }
            ],
            usage: { inputTokens: 2, outputTokens: 1 }
          };
        }

        if (toolMessages.length === 1 && !sawDuplicateNote) {
          return {
            kind: "tool_calls",
            message: "",
            toolCalls: [
              {
                input: { path: join(workspace, "target.txt") },
                reason: "Read target file again.",
                toolCallId: "read-2",
                toolName: "read_file"
              }
            ],
            usage: { inputTokens: 2, outputTokens: 1 }
          };
        }

        return {
          kind: "final",
          message: "done",
          usage: { inputTokens: 2, outputTokens: 1 }
        };
      })
    });

    try {
      const result = await handle.service.runTask(
        createDefaultRunOptions("read twice", workspace, handle.config)
      );
      expect(result.output).toBe("done");
      expect(sawDuplicateNote).toBe(true);
    } finally {
      handle.close();
    }
  });

  it("replays duplicate read_file tool results from cache", async () => {
    const workspace = await fs.mkdtemp(join(tmpdir(), "talon-loop-replay-"));
    tempPaths.push(workspace);
    await fs.writeFile(join(workspace, "target.txt"), "payload", "utf8");

    const handle = createApplication(workspace, {
      config: { databasePath: join(workspace, "runtime.db") },
      provider: new ScriptedProvider((input) => {
        const toolMessages = input.messages.filter((message) => message.role === "tool");

        if (toolMessages.length === 0) {
          return {
            kind: "tool_calls",
            message: "",
            toolCalls: [
              {
                input: { path: join(workspace, "target.txt") },
                reason: "Read target file.",
                toolCallId: "read-1",
                toolName: "read_file"
              }
            ],
            usage: { inputTokens: 2, outputTokens: 1 }
          };
        }

        if (toolMessages.length === 1) {
          return {
            kind: "tool_calls",
            message: "",
            toolCalls: [
              {
                input: { path: join(workspace, "target.txt") },
                reason: "Read target file again.",
                toolCallId: "read-2",
                toolName: "read_file"
              }
            ],
            usage: { inputTokens: 2, outputTokens: 1 }
          };
        }

        return {
          kind: "final",
          message: "done",
          usage: { inputTokens: 2, outputTokens: 1 }
        };
      })
    });

    try {
      const result = await handle.service.runTask(
        createDefaultRunOptions("read twice", workspace, handle.config)
      );
      const details = handle.service.showTask(result.task.taskId);
      const readCalls = details.toolCalls.filter((toolCall) => toolCall.toolName === "read_file");

      expect(result.output).toBe("done");
      expect(
        details.trace.some((event) => event.eventType === "duplicate_tool_replayed")
      ).toBe(true);
      const executedReads = readCalls.filter(
        (toolCall) => !toolCall.summary?.includes("replayed from duplicate cache")
      );
      expect(executedReads).toHaveLength(1);
    } finally {
      handle.close();
    }
  });

  it("does not annotate duplicate shell tool results", async () => {
    const workspace = await fs.mkdtemp(join(tmpdir(), "talon-loop-shell-"));
    tempPaths.push(workspace);

    let lastToolContents: string[] = [];
    const handle = createApplication(workspace, {
      config: { databasePath: join(workspace, "runtime.db") },
      policyConfig: SHELL_ALLOW_POLICY,
      provider: new ScriptedProvider((input) => {
        const toolMessages = input.messages.filter((message) => message.role === "tool");
        lastToolContents = toolMessages.map((message) => message.content);

        if (toolMessages.length === 0) {
          return {
            kind: "tool_calls",
            message: "",
            toolCalls: [
              {
                input: { command: "echo loop-discipline-once" },
                reason: "Run echo once.",
                toolCallId: "shell-1",
                toolName: "shell"
              }
            ],
            usage: { inputTokens: 2, outputTokens: 1 }
          };
        }

        if (toolMessages.length === 1) {
          return {
            kind: "tool_calls",
            message: "",
            toolCalls: [
              {
                input: { command: "echo loop-discipline-once" },
                reason: "Run echo again.",
                toolCallId: "shell-2",
                toolName: "shell"
              }
            ],
            usage: { inputTokens: 2, outputTokens: 1 }
          };
        }

        return {
          kind: "final",
          message: "shell done",
          usage: { inputTokens: 2, outputTokens: 1 }
        };
      })
    });

    try {
      const result = await handle.service.runTask(
        createDefaultRunOptions("shell twice", workspace, handle.config)
      );
      expect(result.output).toBe("shell done");
      expect(lastToolContents.some((content) => content.includes("NOTE: duplicate"))).toBe(false);
    } finally {
      handle.close();
    }
  });

  it("injects progress guard after three silent tool-only turns", async () => {
    const workspace = await fs.mkdtemp(join(tmpdir(), "talon-loop-guard-"));
    tempPaths.push(workspace);
    await fs.writeFile(join(workspace, "a.txt"), "a", "utf8");
    await fs.writeFile(join(workspace, "b.txt"), "b", "utf8");
    await fs.writeFile(join(workspace, "c.txt"), "c", "utf8");

    let lastMessages: ProviderInput["messages"] = [];
    const paths = ["a.txt", "b.txt", "c.txt"];
    const handle = createApplication(workspace, {
      config: {
        compact: {
          iterationThreshold: 999,
          messageThreshold: 999,
          summarizer: "deterministic",
          tokenThreshold: 999_999,
          toolCallThreshold: 999
        },
        databasePath: join(workspace, "runtime.db")
      },
      provider: new ScriptedProvider((input) => {
        lastMessages = input.messages;
        const toolCount = input.messages.filter((message) => message.role === "tool").length;

        if (toolCount < 3) {
          const path = join(workspace, paths[toolCount] ?? "a.txt");
          return {
            kind: "tool_calls",
            message: "",
            toolCalls: [
              {
                input: { path },
                reason: `Read ${path}.`,
                toolCallId: `read-${toolCount + 1}`,
                toolName: "read_file"
              }
            ],
            usage: { inputTokens: 2, outputTokens: 1 }
          };
        }

        return {
          kind: "final",
          message: "answered after guard",
          usage: { inputTokens: 2, outputTokens: 1 }
        };
      })
    });

    try {
      const result = await handle.service.runTask(
        createDefaultRunOptions("explore silently", workspace, handle.config)
      );
      expect(result.output).toBe("answered after guard");
      expect(
        lastMessages.some(
          (message) => message.role === "system" && message.content.includes("progress guard:")
        )
      ).toBe(true);
    } finally {
      handle.close();
    }
  });

  it("does not inject progress guard when reasoning text is present", async () => {
    const workspace = await fs.mkdtemp(join(tmpdir(), "talon-loop-guard-skip-"));
    tempPaths.push(workspace);
    await fs.writeFile(join(workspace, "note.txt"), "note", "utf8");

    let lastMessages: ProviderInput["messages"] = [];
    const handle = createApplication(workspace, {
      config: {
        compact: {
          iterationThreshold: 999,
          messageThreshold: 999,
          summarizer: "deterministic",
          tokenThreshold: 999_999,
          toolCallThreshold: 999
        },
        databasePath: join(workspace, "runtime.db")
      },
      provider: new ScriptedProvider((input) => {
        lastMessages = input.messages;
        const toolCount = input.messages.filter((message) => message.role === "tool").length;

        if (toolCount < 3) {
          return {
            kind: "tool_calls",
            message: `Reasoning before tool ${toolCount + 1}.`,
            toolCalls: [
              {
                input: { path: join(workspace, "note.txt") },
                reason: "Read note.",
                toolCallId: `read-${toolCount + 1}`,
                toolName: "read_file"
              }
            ],
            usage: { inputTokens: 2, outputTokens: 1 }
          };
        }

        return {
          kind: "final",
          message: "answered with reasoning",
          usage: { inputTokens: 2, outputTokens: 1 }
        };
      })
    });

    try {
      const result = await handle.service.runTask(
        createDefaultRunOptions("explore with reasoning", workspace, handle.config)
      );
      expect(result.output).toBe("answered with reasoning");
      expect(
        lastMessages.some(
          (message) => message.role === "system" && message.content.includes("progress guard:")
        )
      ).toBe(false);
    } finally {
      handle.close();
    }
  });

  it("compacts based on cumulative tool call count across iterations", async () => {
    const workspace = await fs.mkdtemp(join(tmpdir(), "talon-loop-cumulative-"));
    tempPaths.push(workspace);
    await fs.writeFile(join(workspace, "one.txt"), "1", "utf8");
    await fs.writeFile(join(workspace, "two.txt"), "2", "utf8");
    await fs.writeFile(join(workspace, "three.txt"), "3", "utf8");
    await fs.writeFile(join(workspace, "four.txt"), "4", "utf8");
    await fs.writeFile(join(workspace, "five.txt"), "5", "utf8");
    await fs.writeFile(join(workspace, "six.txt"), "6", "utf8");

    let iteration = 0;
    let sawSessionSummary = false;
    const readPaths = ["one.txt", "two.txt", "three.txt", "four.txt", "five.txt", "six.txt"];
    const handle = createApplication(workspace, {
      config: {
        compact: {
          iterationThreshold: 999,
          messageThreshold: 999,
          minTokenPressureRatio: 0,
          summarizer: "deterministic",
          tokenThreshold: 999_999,
          toolCallThreshold: 5
        },
        databasePath: join(workspace, "runtime.db")
      },
      provider: new ScriptedProvider((input) => {
        if (input.messages.some((message) => message.content.includes("Session handoff:"))) {
          sawSessionSummary = true;
        }
        iteration += 1;
        const batch = readPaths.splice(0, 3);
        if (batch.length === 0) {
          return {
            kind: "final",
            message: "finished after compaction path",
            usage: { inputTokens: 2, outputTokens: 1 }
          };
        }

        return {
          kind: "tool_calls",
          message: "",
          toolCalls: batch.map((relativePath, index) => ({
            input: { path: join(workspace, relativePath) },
            reason: `Read ${relativePath}.`,
            toolCallId: `read-${iteration}-${index}`,
            toolName: "read_file"
          })),
          usage: { inputTokens: 2, outputTokens: 1 }
        };
      })
    });

    try {
      const result = await handle.service.runTask(
        createDefaultRunOptions("read many files", workspace, handle.config)
      );
      expect(result.output).toBe("finished after compaction path");
      expect(sawSessionSummary).toBe(true);
      expect(iteration).toBeGreaterThanOrEqual(3);
    } finally {
      handle.close();
    }
  });
});
