import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createApplication, createDefaultRunOptions } from "../src/runtime";
import type { Provider, ProviderInput, ProviderResponse, TraceEventType } from "../src/types";

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

describe("Phase 1 runtime", () => {
  it("executes a single-round tool call successfully", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      },
      provider: new ScriptedProvider((input) => {
        if (input.iteration === 1) {
          return {
            kind: "tool_calls",
            message: "Create a file first.",
            toolCalls: [
              {
                input: {
                  action: "write_file",
                  content: "phase-1-single-round",
                  path: "notes.txt"
                },
                reason: "Persist the requested content.",
                toolCallId: "write-1",
                toolName: "file_write"
              }
            ],
            usage: {
              inputTokens: 10,
              outputTokens: 5
            }
          };
        }

        return {
          kind: "final",
          message: "notes.txt created",
          usage: {
            inputTokens: 4,
            outputTokens: 4
          }
        };
      })
    });

    try {
      const result = await handle.service.runTask(
        createDefaultRunOptions("create notes.txt", workspaceRoot, handle.config)
      );

      expect(result.error).toBeUndefined();
      expect(result.task.status).toBe("succeeded");
      expect(await fs.readFile(join(workspaceRoot, "notes.txt"), "utf8")).toBe(
        "phase-1-single-round"
      );

      const details = handle.service.showTask(result.task.taskId);
      expect(details.toolCalls).toHaveLength(1);
      expect(details.toolCalls[0]?.status).toBe("finished");
      expect(details.task?.finalOutput).toBe("notes.txt created");
    } finally {
      handle.close();
    }
  });

  it("supports multi-round tool call feedback loops", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      },
      provider: new ScriptedProvider((input) => {
        const toolMessages = input.messages.filter((message) => message.role === "tool");

        if (toolMessages.length === 0) {
          return {
            kind: "tool_calls",
            message: "Write the intermediate file.",
            toolCalls: [
              {
                input: {
                  action: "write_file",
                  content: "multi-round-content",
                  path: "chain.txt"
                },
                reason: "Need content for the next step.",
                toolCallId: "write-chain",
                toolName: "file_write"
              }
            ],
            usage: {
              inputTokens: 12,
              outputTokens: 5
            }
          };
        }

        if (toolMessages.length === 1) {
          return {
            kind: "tool_calls",
            message: "Read the file to verify its contents.",
            toolCalls: [
              {
                input: {
                  action: "read_file",
                  path: "chain.txt"
                },
                reason: "Need the written content for the final answer.",
                toolCallId: "read-chain",
                toolName: "file_read"
              }
            ],
            usage: {
              inputTokens: 10,
              outputTokens: 5
            }
          };
        }

        return {
          kind: "final",
          message: `Finalized with tool feedback: ${toolMessages.at(-1)?.content ?? ""}`,
          usage: {
            inputTokens: 6,
            outputTokens: 8
          }
        };
      })
    });

    try {
      const result = await handle.service.runTask(
        createDefaultRunOptions("perform a multi-step file round-trip", workspaceRoot, handle.config)
      );

      expect(result.error).toBeUndefined();
      expect(result.task.status).toBe("succeeded");
      expect(result.output).toContain("multi-round-content");

      const details = handle.service.showTask(result.task.taskId);
      expect(details.toolCalls.map((toolCall) => toolCall.toolName)).toEqual([
        "file_write",
        "file_read"
      ]);
    } finally {
      handle.close();
    }
  });

  it("captures tool failure details for error localization", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      },
      provider: new ScriptedProvider(() => ({
        kind: "tool_calls",
        message: "Attempt to read a missing file.",
        toolCalls: [
          {
            input: {
              action: "read_file",
              path: "missing.txt"
            },
            reason: "The task requests a file read.",
            toolCallId: "missing-read",
            toolName: "file_read"
          }
        ],
        usage: {
          inputTokens: 10,
          outputTokens: 5
        }
      }))
    });

    try {
      const result = await handle.service.runTask(
        createDefaultRunOptions("read a missing file", workspaceRoot, handle.config)
      );

      expect(result.error?.code).toBe("tool_execution_error");
      expect(result.task.status).toBe("failed");

      const details = handle.service.showTask(result.task.taskId);
      expect(details.toolCalls[0]?.status).toBe("failed");
      expect(details.toolCalls[0]?.errorMessage).toContain("missing.txt");
      expect(details.trace.some((event) => event.eventType === "tool_call_failed")).toBe(true);
    } finally {
      handle.close();
    }
  });

  it("fails shell tool calls on timeout", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      },
      provider: new ScriptedProvider(() => ({
        kind: "tool_calls",
        message: "Run a shell command that exceeds the tool timeout.",
        toolCalls: [
          {
            input: {
              command: "node -e 'setTimeout(() => process.exit(0), 500)'",
              timeoutMs: 50
            },
            reason: "Validate shell timeout handling.",
            toolCallId: "slow-shell",
            toolName: "shell"
          }
        ],
        usage: {
          inputTokens: 8,
          outputTokens: 4
        }
      }))
    });

    try {
      const result = await handle.service.runTask(
        createDefaultRunOptions("run a slow shell command", workspaceRoot, handle.config)
      );

      expect(result.error?.code).toBe("timeout");
      expect(result.task.status).toBe("failed");

      const trace = handle.service.traceTask(result.task.taskId);
      expect(trace.some((event) => event.eventType === "interrupt")).toBe(true);
      expect(trace.some((event) => event.eventType === "tool_call_failed")).toBe(true);
    } finally {
      handle.close();
    }
  });

  it("enforces FileWriteTool path restrictions", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      },
      provider: new ScriptedProvider(() => ({
        kind: "tool_calls",
        message: "Attempt to write outside the workspace.",
        toolCalls: [
          {
            input: {
              action: "write_file",
              content: "denied",
              path: "..\\outside.txt"
            },
            reason: "Verify write-path policy enforcement.",
            toolCallId: "outside-write",
            toolName: "file_write"
          }
        ],
        usage: {
          inputTokens: 8,
          outputTokens: 4
        }
      }))
    });

    try {
      const result = await handle.service.runTask(
        createDefaultRunOptions("attempt to escape the workspace", workspaceRoot, handle.config)
      );

      expect(result.error?.code).toBe("policy_denied");
      expect(result.task.status).toBe("failed");
      await expect(fs.access(join(workspaceRoot, "..", "outside.txt"))).rejects.toThrow();
    } finally {
      handle.close();
    }
  });

  it("persists complete trace chains for successful runs", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      },
      provider: new ScriptedProvider((input) => {
        if (input.iteration === 1) {
          return {
            kind: "tool_calls",
            message: "Create trace-target.txt.",
            toolCalls: [
              {
                input: {
                  action: "write_file",
                  content: "trace",
                  path: "trace-target.txt"
                },
                reason: "Need one tool invocation for trace coverage.",
                toolCallId: "trace-write",
                toolName: "file_write"
              }
            ],
            usage: {
              inputTokens: 10,
              outputTokens: 5
            }
          };
        }

        return {
          kind: "final",
          message: "Trace flow completed.",
          usage: {
            inputTokens: 4,
            outputTokens: 4
          }
        };
      })
    });

    try {
      const result = await handle.service.runTask(
        createDefaultRunOptions("build a trace-complete task", workspaceRoot, handle.config)
      );

      const trace = handle.service.traceTask(result.task.taskId);
      const eventTypes = trace.map((event) => event.eventType);
      const requiredEventTypes: TraceEventType[] = [
        "task_created",
        "task_started",
        "model_request",
        "model_response",
        "tool_call_requested",
        "tool_call_started",
        "tool_call_finished",
        "loop_iteration_completed",
        "final_outcome"
      ];

      for (const eventType of requiredEventTypes) {
        expect(eventTypes).toContain(eventType);
      }

      expect(trace.every((event) => event.taskId === result.task.taskId)).toBe(true);
      expect(trace.every((event, index) => index === 0 || event.sequence > trace[index - 1]!.sequence)).toBe(
        true
      );
    } finally {
      handle.close();
    }
  });
});

async function createTempWorkspace(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "tentaclaw-phase1-"));
  tempPaths.push(workspaceRoot);
  return workspaceRoot;
}
