import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createApplication, createDefaultRunOptions } from "../src/runtime/index.js";
import type { Provider, ProviderInput, ProviderResponse } from "../src/types/index.js";

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

describe("ExperienceCollector runtime hooks", () => {
  it("captures task success and session end experiences without writing final output memory", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      },
      provider: new ScriptedProvider(() => ({
        kind: "final",
        message: "Use vitest for runtime verification.",
        usage: {
          inputTokens: 10,
          outputTokens: 5
        }
      }))
    });

    try {
      const result = await handle.service.runTask(
        createDefaultRunOptions("capture task success", workspaceRoot, handle.config)
      );
      const experiences = handle.infrastructure.storage.experiences.list({
        taskId: result.task.taskId
      });

      expect(experiences.map((experience) => experience.type)).toEqual(
        expect.arrayContaining(["task_outcome"])
      );
      expect(
        handle.infrastructure.storage.memories
          .list({ includeExpired: true, includeRejected: true })
          .some((memory) => memory.sourceType === "final_output")
      ).toBe(false);
      expect(
        handle.service
          .traceTask(result.task.taskId)
          .some((event) => event.eventType === "task_success")
      ).toBe(true);
    } finally {
      handle.close();
    }
  });

  it("captures task failures as failure lessons", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      },
      provider: new ScriptedProvider(() => {
        throw new Error("provider exploded");
      })
    });

    try {
      const result = await handle.service.runTask(
        createDefaultRunOptions("capture task failure", workspaceRoot, handle.config)
      );
      const experiences = handle.infrastructure.storage.experiences.list({
        taskId: result.task.taskId,
        type: "failure_lesson"
      });

      expect(result.error?.message).toContain("provider exploded");
      expect(experiences[0]?.sourceType).toBe("task");
      expect(experiences[0]?.indexSignals.errorCodes).toContain("provider_error");
    } finally {
      handle.close();
    }
  });

  it("captures tool results and pre-compress hooks", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.writeFile(join(workspaceRoot, "README.md"), "runtime context");
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      },
      provider: new ScriptedProvider((input) => {
        const toolCount = input.messages.filter((message) => message.role === "tool").length;
        if (toolCount === 0) {
          return {
            kind: "tool_calls",
            message: "Read the workspace file.",
            toolCalls: [
              {
                input: {
                  action: "read_file",
                  path: "README.md"
                },
                reason: "Need context",
                toolCallId: "tool-readme",
                toolName: "file_read"
              }
            ],
            usage: {
              inputTokens: 8,
              outputTokens: 4
            }
          };
        }

        return {
          kind: "final",
          message: "Read README and finished.",
          usage: {
            inputTokens: 10,
            outputTokens: 4
          }
        };
      })
    });

    try {
      const result = await handle.service.runTask(
        createDefaultRunOptions("read before finishing", workspaceRoot, handle.config)
      );
      const experiences = handle.infrastructure.storage.experiences.list({
        taskId: result.task.taskId
      });

      expect(experiences.map((experience) => experience.sourceType)).toContain("tool_result");
      expect(experiences.map((experience) => experience.title)).toContain("Pre-compress signal");
    } finally {
      handle.close();
    }
  });
});

async function createTempWorkspace(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-experience-"));
  tempPaths.push(workspaceRoot);
  return workspaceRoot;
}
