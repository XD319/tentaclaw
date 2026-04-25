import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { serializeFocusState, type FocusState } from "../src/runtime/focus-state.js";
import { createApplication, createDefaultRunOptions } from "../src/runtime/index.js";
import type { Provider, ProviderInput, ProviderResponse } from "../src/types/index.js";

class QueueProvider implements Provider {
  public readonly name = "queue-provider";
  private step = 0;

  public constructor(
    private readonly handlers: Array<(input: ProviderInput) => ProviderResponse | Promise<ProviderResponse>>
  ) {}

  public async generate(input: ProviderInput): Promise<ProviderResponse> {
    const handler = this.handlers[this.step];
    this.step += 1;
    if (handler === undefined) {
      throw new Error(`Unexpected provider call ${this.step}.`);
    }
    return handler(input);
  }
}

describe("focus resolution", () => {
  it("binds 'this document' to the most recently written file in a continued thread", async () => {
    const workspace = createWorkspace();
    const provider = new QueueProvider([
      () => ({
        kind: "tool_calls",
        message: "Create the document first.",
        toolCalls: [
          {
            input: {
              action: "write_file",
              content: "tetoris draft",
              path: "tetoris.md"
            },
            reason: "Create the requested file.",
            toolCallId: "tc-write-tetoris",
            toolName: "file_write"
          }
        ],
        usage: { inputTokens: 1, outputTokens: 1 }
      }),
      () => ({
        kind: "final",
        message: "created",
        usage: { inputTokens: 1, outputTokens: 1 }
      }),
      (input) => {
        expect(input.messages[0]?.content).toContain("tetoris.md");
        return {
          kind: "final",
          message: "translated",
          usage: { inputTokens: 1, outputTokens: 1 }
        };
      }
    ]);
    const handle = createApplication(workspace, {
      config: {
        databasePath: join(workspace, "runtime.db")
      },
      provider
    });

    try {
      const first = await handle.service.runTask(
        createDefaultRunOptions("创建 tetoris.md", workspace, handle.config)
      );
      const second = await handle.service.continueThread(
        first.task.threadId!,
        "把这个文档改成中文的",
        { cwd: workspace }
      );
      expect(second.output).toBe("translated");
    } finally {
      handle.close();
      cleanupWorkspace(workspace);
    }
  });

  it("clarifies instead of guessing when two recent files are equally likely", async () => {
    const workspace = createWorkspace();
    const provider = new QueueProvider([
      () => ({
        kind: "tool_calls",
        message: "Create both files.",
        toolCalls: [
          {
            input: {
              action: "write_file",
              content: "readme",
              path: "README.md"
            },
            reason: "Create README.",
            toolCallId: "tc-write-readme",
            toolName: "file_write"
          },
          {
            input: {
              action: "write_file",
              content: "tetoris",
              path: "tetoris.md"
            },
            reason: "Create tetoris doc.",
            toolCallId: "tc-write-tetoris",
            toolName: "file_write"
          }
        ],
        usage: { inputTokens: 1, outputTokens: 1 }
      }),
      () => ({
        kind: "final",
        message: "created",
        usage: { inputTokens: 1, outputTokens: 1 }
      })
    ]);
    const handle = createApplication(workspace, {
      config: {
        databasePath: join(workspace, "runtime.db")
      },
      provider
    });

    try {
      const first = await handle.service.runTask(
        createDefaultRunOptions("创建 README.md 和 tetoris.md", workspace, handle.config)
      );
      const second = await handle.service.continueThread(
        first.task.threadId!,
        "把这个文档改成中文的",
        { cwd: workspace }
      );
      expect(second.output).toContain("README.md");
      expect(second.output).toContain("tetoris.md");
    } finally {
      handle.close();
      cleanupWorkspace(workspace);
    }
  });

  it("binds 'this function' to a uniquely read symbol", async () => {
    const workspace = createWorkspace();
    await fs.writeFile(
      join(workspace, "parser.ts"),
      "export function parseTask(input: string) {\n  return input.trim();\n}\n",
      "utf8"
    );
    const provider = new QueueProvider([
      () => ({
        kind: "tool_calls",
        message: "Read parser first.",
        toolCalls: [
          {
            input: {
              action: "read_file",
              path: "parser.ts"
            },
            reason: "Need the parser function.",
            toolCallId: "tc-read-parser",
            toolName: "file_read"
          }
        ],
        usage: { inputTokens: 1, outputTokens: 1 }
      }),
      () => ({
        kind: "final",
        message: "read",
        usage: { inputTokens: 1, outputTokens: 1 }
      }),
      (input) => {
        expect(input.messages.some((message) => message.content.includes("parseTask"))).toBe(true);
        expect(input.messages.some((message) => message.content.includes("parser.ts"))).toBe(true);
        return {
          kind: "final",
          message: "updated function",
          usage: { inputTokens: 1, outputTokens: 1 }
        };
      }
    ]);
    const handle = createApplication(workspace, {
      config: {
        databasePath: join(workspace, "runtime.db")
      },
      provider
    });

    try {
      const first = await handle.service.runTask(
        createDefaultRunOptions("查看 parser.ts", workspace, handle.config)
      );
      const latestRun = handle.service.showThread(first.task.threadId!).runs.at(-1);
      expect(JSON.stringify(latestRun?.metadata ?? {})).toContain("parseTask");
      const second = await handle.service.continueThread(
        first.task.threadId!,
        "把这个函数改下",
        { cwd: workspace }
      );
      expect(second.output).toBe("updated function");
    } finally {
      handle.close();
      cleanupWorkspace(workspace);
    }
  });

  it("rehydrates file focus from thread snapshot metadata", async () => {
    const workspace = createWorkspace();
    const provider = new QueueProvider([
      () => ({
        kind: "final",
        message: "seed thread",
        usage: { inputTokens: 1, outputTokens: 1 }
      }),
      (input) => {
        expect(input.messages[0]?.content).toContain("notes.md");
        return {
          kind: "final",
          message: "snapshot focus ok",
          usage: { inputTokens: 1, outputTokens: 1 }
        };
      }
    ]);
    const handle = createApplication(workspace, {
      config: {
        databasePath: join(workspace, "runtime.db")
      },
      provider
    });

    try {
      const first = await handle.service.runTask(
        createDefaultRunOptions("创建线程", workspace, handle.config)
      );
      const threadId = first.task.threadId!;
      handle.infrastructure.storage.threadSnapshots.create({
        activeMemoryIds: [],
        goal: "Keep editing notes",
        metadata: {
          focusState: serializeFocusState(fileFocusState(join(workspace, "notes.md")))
        },
        nextActions: [],
        openLoops: [],
        snapshotId: "focus-snapshot",
        summary: "focus snapshot",
        taskId: first.task.taskId,
        threadId,
        toolCapabilitySummary: ["file_read"],
        trigger: "manual"
      });

      const resumed = await handle.service.continueThread(threadId, "把这个文件改成中文", {
        cwd: workspace
      });
      expect(resumed.output).toBe("snapshot focus ok");
    } finally {
      handle.close();
      cleanupWorkspace(workspace);
    }
  });

  it("rehydrates url focus from thread snapshot metadata", async () => {
    const workspace = createWorkspace();
    const provider = new QueueProvider([
      () => ({
        kind: "final",
        message: "seed thread",
        usage: { inputTokens: 1, outputTokens: 1 }
      }),
      (input) => {
        expect(input.messages[0]?.content).toContain("https://example.com/docs");
        return {
          kind: "final",
          message: "url focus ok",
          usage: { inputTokens: 1, outputTokens: 1 }
        };
      }
    ]);
    const handle = createApplication(workspace, {
      config: {
        databasePath: join(workspace, "runtime.db")
      },
      provider
    });

    try {
      const first = await handle.service.runTask(
        createDefaultRunOptions("创建线程", workspace, handle.config)
      );
      const threadId = first.task.threadId!;
      handle.infrastructure.storage.threadSnapshots.create({
        activeMemoryIds: [],
        goal: "Keep translating docs",
        metadata: {
          focusState: {
            activeTarget: {
              id: "https://example.com/docs",
              kind: "url",
              label: "https://example.com/docs",
              lastTouchedAt: "2026-04-25T00:00:00.000Z",
              score: 0.9,
              source: "web_fetch",
              taskId: first.task.taskId,
              url: "https://example.com/docs",
              userTurnIndex: 1
            },
            recentTargets: [
              {
                id: "https://example.com/docs",
                kind: "url",
                label: "https://example.com/docs",
                lastTouchedAt: "2026-04-25T00:00:00.000Z",
                score: 0.9,
                source: "web_fetch",
                taskId: first.task.taskId,
                url: "https://example.com/docs",
                userTurnIndex: 1
              }
            ],
            userTurnIndex: 1
          }
        },
        nextActions: [],
        openLoops: [],
        snapshotId: "url-focus-snapshot",
        summary: "url focus snapshot",
        taskId: first.task.taskId,
        threadId,
        toolCapabilitySummary: ["web_fetch"],
        trigger: "manual"
      });

      const resumed = await handle.service.continueThread(threadId, "把这个页面翻成中文", {
        cwd: workspace
      });
      expect(resumed.output).toBe("url focus ok");
    } finally {
      handle.close();
      cleanupWorkspace(workspace);
    }
  });

  it("hides web_fetch for local file translation turns", async () => {
    const workspace = createWorkspace();
    const provider = new QueueProvider([
      () => ({
        kind: "tool_calls",
        message: "Create the file first.",
        toolCalls: [
          {
            input: {
              action: "write_file",
              content: "hello world",
              path: "tetoris.md"
            },
            reason: "Create a local document.",
            toolCallId: "tc-write-local-file",
            toolName: "file_write"
          }
        ],
        usage: { inputTokens: 1, outputTokens: 1 }
      }),
      () => ({
        kind: "final",
        message: "created",
        usage: { inputTokens: 1, outputTokens: 1 }
      }),
      (input) => {
        expect(input.availableTools.some((tool) => tool.name === "web_fetch")).toBe(false);
        expect(input.messages[0]?.content).toContain("tetoris.md");
        return {
          kind: "final",
          message: "translated locally",
          usage: { inputTokens: 1, outputTokens: 1 }
        };
      }
    ]);
    const handle = createApplication(workspace, {
      config: {
        databasePath: join(workspace, "runtime.db")
      },
      provider
    });

    try {
      const first = await handle.service.runTask(
        createDefaultRunOptions("create tetoris.md", workspace, handle.config)
      );
      const second = await handle.service.continueThread(
        first.task.threadId!,
        "把这个文档里的内容翻译成英文",
        { cwd: workspace }
      );
      expect(second.output).toBe("translated locally");
    } finally {
      handle.close();
      cleanupWorkspace(workspace);
    }
  });
});

function fileFocusState(path: string): FocusState {
  return {
    activeTarget: {
      id: path,
      kind: "file",
      label: "notes.md",
      lastTouchedAt: "2026-04-25T00:00:00.000Z",
      path,
      score: 0.95,
      source: "file_write",
      taskId: "snapshot-task",
      userTurnIndex: 1
    },
    recentTargets: [
      {
        id: path,
        kind: "file",
        label: "notes.md",
        lastTouchedAt: "2026-04-25T00:00:00.000Z",
        path,
        score: 0.95,
        source: "file_write",
        taskId: "snapshot-task",
        userTurnIndex: 1
      }
    ],
    userTurnIndex: 1
  };
}

function createWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "auto-talon-focus-"));
}

function cleanupWorkspace(path: string): void {
  rmSync(path, { force: true, recursive: true });
}
