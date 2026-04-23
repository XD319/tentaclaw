import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { formatTaskTimeline } from "../src/cli/formatters.js";
import { createApplication, createDefaultRunOptions } from "../src/runtime/index.js";
import type { Provider, ProviderInput, ProviderResponse } from "../src/types/index.js";

class ScriptedProvider implements Provider {
  public readonly name = "timeline-scripted-provider";

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

describe("timeline and diff observability", () => {
  it("exposes timeline entries, persisted provider stats, and unified file diffs", async () => {
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
            message: "Write a file for observability.",
            toolCalls: [
              {
                input: {
                  action: "write_file",
                  content: "hello\n",
                  path: "observed.txt"
                },
                reason: "Create a diff artifact.",
                toolCallId: "timeline-write",
                toolName: "file_write"
              }
            ],
            usage: {
              inputTokens: 10,
              outputTokens: 5,
              totalTokens: 15
            }
          };
        }

        return {
          kind: "final",
          message: "observed.txt written",
          usage: {
            inputTokens: 4,
            outputTokens: 3,
            totalTokens: 7
          }
        };
      })
    });

    try {
      const result = await handle.service.runTask(
        createDefaultRunOptions("write observable file", workspaceRoot, handle.config)
      );
      const timeline = handle.service.taskTimeline(result.task.taskId);
      const formatted = formatTaskTimeline(timeline);
      const fileArtifact = handle.service
        .showTask(result.task.taskId)
        .artifacts.find((artifact) => artifact.artifactType === "file");
      const stats = handle.service.providerStats();

      expect(timeline.entries.some((entry) => entry.eventType === "provider_request_succeeded")).toBe(true);
      expect(timeline.entries.some((entry) => entry.eventType === "tool_call_finished")).toBe(true);
      expect(formatted).toContain("Timeline for");
      expect(fileArtifact?.content).toMatchObject({
        operation: "write_file",
        path: join(workspaceRoot, "observed.txt")
      });
      expect(JSON.stringify(fileArtifact?.content)).toContain("+++ b/");
      expect(stats?.totalRequests).toBe(2);
      expect(stats?.tokenUsage.totalTokens).toBe(22);
    } finally {
      handle.close();
    }
  });
});

async function createTempWorkspace(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-timeline-"));
  tempPaths.push(workspaceRoot);
  return workspaceRoot;
}
