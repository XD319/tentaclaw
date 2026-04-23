import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { replayTaskById } from "../src/diagnostics/index.js";
import { createApplication, createDefaultRunOptions } from "../src/runtime/index.js";
import type { Provider, ProviderInput, ProviderResponse } from "../src/types/index.js";

class ScriptedProvider implements Provider {
  public readonly name = "replay-scripted-provider";

  public constructor(
    private readonly responder: (input: ProviderInput) => Promise<ProviderResponse> | ProviderResponse,
    public readonly model = "replay-scripted-model"
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

describe("replay diagnostics", () => {
  it("replays a persisted task from its historical chain", async () => {
    const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-replay-"));
    tempPaths.push(workspaceRoot);
    await fs.writeFile(join(workspaceRoot, "README.md"), "replay fixture", "utf8");

    const handle = createApplication(workspaceRoot, {
      provider: new ScriptedProvider((input) => {
        const toolMessages = input.messages.filter((message) => message.role === "tool");

        if (toolMessages.length > 0) {
          return {
            kind: "final",
            message: "historical chain completed",
            usage: {
              inputTokens: 6,
              outputTokens: 3,
              totalTokens: 9
            }
          };
        }

        return {
          kind: "tool_calls",
          message: "read the fixture file",
          toolCalls: [
            {
              input: {
                action: "read_file",
                path: "README.md"
              },
              reason: "Need fixture content.",
              toolCallId: "replay-readme",
              toolName: "file_read"
            }
          ],
          usage: {
            inputTokens: 8,
            outputTokens: 4,
            totalTokens: 12
          }
        };
      })
    });

    try {
      const original = await handle.service.runTask(
        createDefaultRunOptions("inspect README and finish", workspaceRoot, handle.config)
      );

      expect(original.task.status).toBe("succeeded");

      const replay = await replayTaskById(original.task.taskId, {
        cwd: workspaceRoot,
        fromIteration: 1,
        providerMode: "mock"
      });

      expect(replay.reference.task.taskId).toBe(original.task.taskId);
      expect(replay.reference.iterationSummaries.length).toBeGreaterThan(0);
      expect(replay.reference.toolCalls.length).toBeGreaterThan(0);
      expect(replay.replayTask.taskId).not.toBe(original.task.taskId);
      expect(["succeeded", "failed"]).toContain(replay.replayTask.status);
      expect(replay.trace.some((event) => event.eventType === "task_created")).toBe(true);
    } finally {
      handle.close();
    }
  });
});
