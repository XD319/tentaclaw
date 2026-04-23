import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { buildRepoMap, createApplication, createDefaultRunOptions } from "../src/runtime/index.js";
import type { LocalPolicyConfig, Provider, ProviderInput, ProviderResponse } from "../src/types/index.js";

class ScriptedProvider implements Provider {
  public readonly name = "workflow-scripted-provider";

  public constructor(
    private readonly responder: (input: ProviderInput) => Promise<ProviderResponse> | ProviderResponse
  ) {}

  public async generate(input: ProviderInput): Promise<ProviderResponse> {
    return this.responder(input);
  }
}

const tempPaths: string[] = [];

const WORKFLOW_POLICY_CONFIG: LocalPolicyConfig = {
  defaultEffect: "deny",
  rules: [
    {
      description: "Allow configured test runner tool in workflow tests.",
      effect: "allow",
      id: "allow-test-run",
      match: {
        toolNames: ["test_run"]
      },
      priority: 100
    },
    {
      description: "Allow workspace file writes.",
      effect: "allow",
      id: "allow-workspace-file-write",
      match: {
        capabilities: ["filesystem.write"],
        pathScopes: ["workspace"]
      },
      priority: 90
    },
    {
      description: "Allow workspace reads.",
      effect: "allow",
      id: "allow-workspace-read",
      match: {
        capabilities: ["filesystem.read"],
        pathScopes: ["workspace"]
      },
      priority: 80
    }
  ],
  source: "local"
};

afterEach(async () => {
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined) {
      await fs.rm(tempPath, { force: true, recursive: true });
    }
  }
});

describe("coding workflow loop", () => {
  it("builds a repository map from workspace files", async () => {
    const workspaceRoot = await createWorkflowWorkspace();
    const repoMap = buildRepoMap(workspaceRoot);

    expect(repoMap.languages).toContain("JavaScript");
    expect(repoMap.importantFiles).toContain("package.json");
    expect(repoMap.scripts.test).toBe("node check.js");
    expect(repoMap.summary).toContain("Repository map");
  });

  it("feeds repo map context and test_run failures back into a repair loop", async () => {
    const workspaceRoot = await createWorkflowWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db"),
        workflow: {
          failureGuidedRetry: {
            enabled: true,
            maxRepairAttempts: 2
          },
          repoMap: {
            enabled: true
          },
          testCommands: ["node check.js"]
        }
      },
      policyConfig: WORKFLOW_POLICY_CONFIG,
      provider: new ScriptedProvider((input) => {
        if (!input.availableTools.some((tool) => tool.name === "test_run")) {
          throw new Error(`missing test_run tool: ${input.availableTools.map((tool) => tool.name).join(",")}`);
        }
        if (!input.messages.some((message) => message.content.includes("Repository map"))) {
          throw new Error(`missing repo map message: ${input.messages.map((message) => message.content).join(" | ")}`);
        }
        const toolMessages = input.messages.filter((message) => message.role === "tool");
        const lastToolMessage = toolMessages.at(-1)?.content ?? "";

        if (toolMessages.length === 0) {
          return toolCallResponse("Run the configured test first.", [
            {
              input: {
                command: "node check.js"
              },
              reason: "Verify current code before repair.",
              toolCallId: "workflow-test-1",
              toolName: "test_run"
            }
          ]);
        }

        if (lastToolMessage.includes("\"passed\": false")) {
          return toolCallResponse("Repair the failing check.", [
            {
              input: {
                action: "update_file",
                newText: "process.exit(0);\n",
                path: "check.js",
                targetText: "process.exit(1);\n"
              },
              reason: "Make the check pass after the failed test feedback.",
              toolCallId: "workflow-repair",
              toolName: "file_write"
            }
          ]);
        }

        if (lastToolMessage.includes("\"passed\": true")) {
          return finalResponse("Repair loop complete; configured test passes.");
        }

        if (toolMessages.some((message) => message.content.includes("\"updated\": true"))) {
          return toolCallResponse("Re-run the configured test after repair.", [
            {
              input: {
                command: "node check.js"
              },
              reason: "Confirm the repair.",
              toolCallId: `workflow-test-${toolMessages.length + 1}`,
              toolName: "test_run"
            }
          ]);
        }

        return finalResponse("Repair loop complete; configured test passes.");
      })
    });

    try {
      const result = await handle.service.runTask(
        createDefaultRunOptions("fix the failing workflow check", workspaceRoot, handle.config)
      );
      const details = handle.service.showTask(result.task.taskId);

      expect(result.error?.message).toBeUndefined();
      expect(result.task.status).toBe("succeeded");
      expect(await fs.readFile(join(workspaceRoot, "check.js"), "utf8")).toBe("process.exit(0);\n");
      expect(details.trace.some((event) => event.eventType === "repo_map_created")).toBe(true);
      expect(details.toolCalls.filter((toolCall) => toolCall.toolName === "test_run")).toHaveLength(2);
      expect(details.toolCalls.every((toolCall) => toolCall.status === "finished")).toBe(true);
    } finally {
      handle.close();
    }
  });
});

async function createWorkflowWorkspace(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-workflow-loop-"));
  tempPaths.push(workspaceRoot);
  await fs.writeFile(
    join(workspaceRoot, "package.json"),
    JSON.stringify(
      {
        name: "workflow-fixture",
        scripts: {
          test: "node check.js"
        }
      },
      null,
      2
    ),
    "utf8"
  );
  await fs.writeFile(join(workspaceRoot, "check.js"), "process.exit(1);\n", "utf8");
  return workspaceRoot;
}

function toolCallResponse(message: string, toolCalls: Array<{
  input: Record<string, unknown>;
  reason: string;
  toolCallId: string;
  toolName: string;
}>): ProviderResponse {
  return {
    kind: "tool_calls",
    message,
    toolCalls,
    usage: {
      inputTokens: 10,
      outputTokens: 5
    }
  };
}

function finalResponse(message: string): ProviderResponse {
  return {
    kind: "final",
    message,
    usage: {
      inputTokens: 5,
      outputTokens: 5
    }
  };
}
