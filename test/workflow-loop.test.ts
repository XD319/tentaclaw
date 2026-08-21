import { promises as fs } from "node:fs";
import { join } from "node:path";

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
      description: "Allow shell verification in workflow tests.",
      effect: "allow",
      id: "allow-shell",
      match: {
        toolNames: ["shell"]
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

  it("feeds repo map context and shell verification failures back into a repair loop", async () => {
    const workspaceRoot = await createWorkflowWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db"),
        defaultProfileId: "executor",
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
        if (!input.availableTools.some((tool) => tool.name === "shell")) {
          throw new Error(`missing shell tool: ${input.availableTools.map((tool) => tool.name).join(",")}`);
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
              toolName: "shell"
            }
          ]);
        }

        if (lastToolMessage.includes("exited with code 1")) {
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
              toolName: "patch"
            }
          ]);
        }

        if (lastToolMessage.includes("\"exitCode\":0")) {
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
              toolName: "shell"
            }
          ]);
        }

        return finalResponse("Repair loop complete; configured test passes.");
      })
    });

    try {
      const runOptions = createDefaultRunOptions("fix the failing workflow check", workspaceRoot, handle.config);
      runOptions.agentProfileId = "executor";
      const result = await handle.service.runTask(runOptions);
      const details = handle.service.showTask(result.task.taskId);

      expect(details.trace.some((event) => event.eventType === "repo_map_created")).toBe(true);
      if (result.error?.message?.startsWith("missing shell tool:")) {
        expect(result.task.status).toBe("failed");
        expect(result.error.message).toContain("shell");
      } else {
        expect(result.error?.message).toBeUndefined();
        expect(result.task.status).toBe("succeeded");
        expect(await fs.readFile(join(workspaceRoot, "check.js"), "utf8")).toBe("process.exit(0);\n");
        expect(
          details.toolCalls.filter((toolCall) => toolCall.toolName === "shell").length
        ).toBeGreaterThanOrEqual(2);
        expect(details.toolCalls.every((toolCall) => toolCall.status === "finished" || toolCall.status === "failed")).toBe(true);
      }
    } finally {
      handle.close();
    }
  }, 30000);

  it("requests a no-tools summary instead of failing when iterations are exhausted", async () => {
    const workspaceRoot = await createWorkflowWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") },
      policyConfig: WORKFLOW_POLICY_CONFIG,
      provider: new ScriptedProvider((input) => {
        if (input.availableTools.length === 0) {
          return finalResponse("Summary after iteration budget: inspected the workspace.");
        }
        return toolCallResponse("Need one more look.", [
          {
            input: { path: "package.json" },
            reason: "Keep inspecting.",
            toolCallId: `read-${input.iteration}`,
            toolName: "read_file"
          }
        ]);
      })
    });

    try {
      const runOptions = createDefaultRunOptions("inspect until summary", workspaceRoot, handle.config);
      runOptions.maxIterations = 2;
      const result = await handle.service.runTask(runOptions);
      const trace = handle.service.traceTask(result.task.taskId);

      expect(result.task.status).toBe("succeeded");
      expect(result.output).toContain("Summary after iteration budget");
      expect(trace.some((event) => event.eventType === "iteration_budget_pressure")).toBe(true);
    } finally {
      handle.close();
    }
  });

  it("stops post-completion read loops with a no-tools final summary", async () => {
    const workspaceRoot = await createWorkflowWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") },
      policyConfig: WORKFLOW_POLICY_CONFIG,
      provider: new ScriptedProvider((input) => {
        if (input.availableTools.length === 0) {
          return finalResponse("第一阶段已完成：创建了页面和说明。");
        }
        const toolMessages = input.messages.filter((message) => message.role === "tool");
        if (toolMessages.length === 0) {
          return toolCallResponse("开始创建文件。", [
            {
              input: { content: "done\n", path: "phase.txt" },
              reason: "Create the requested phase artifact.",
              toolCallId: "write-phase",
              toolName: "write_file"
            }
          ]);
        }
        return toolCallResponse("第一阶段已完成。", [
          {
            input: { path: "phase.txt" },
            reason: "Verify the completed phase.",
            toolCallId: `verify-${input.iteration}`,
            toolName: "read_file"
          }
        ]);
      })
    });

    try {
      const runOptions = createDefaultRunOptions("开发第一阶段", workspaceRoot, handle.config);
      runOptions.maxIterations = 8;
      const result = await handle.service.runTask(runOptions);
      const details = handle.service.showTask(result.task.taskId);
      const phaseReads = details.toolCalls.filter(
        (toolCall) => toolCall.toolName === "read_file" && toolCall.toolCallId.startsWith("verify-")
      );

      expect(result.task.status).toBe("succeeded");
      expect(result.output).toContain("第一阶段已完成");
      expect(phaseReads).toHaveLength(1);
    } finally {
      handle.close();
    }
  });

  it("ignores tool calls returned by a no-tools final summary response", async () => {
    const workspaceRoot = await createWorkflowWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") },
      policyConfig: WORKFLOW_POLICY_CONFIG,
      provider: new ScriptedProvider((input) => {
        if (input.availableTools.length === 0) {
          return toolCallResponse("Summary with ignored tool call.", [
            {
              input: { path: "package.json" },
              reason: "This should be ignored.",
              toolCallId: "ignored-read",
              toolName: "read_file"
            }
          ]);
        }
        return toolCallResponse("Keep reading.", [
          {
            input: { path: "package.json" },
            reason: "Use the loop budget.",
            toolCallId: `budget-read-${input.iteration}`,
            toolName: "read_file"
          }
        ]);
      })
    });

    try {
      const runOptions = createDefaultRunOptions("summarize even with tools", workspaceRoot, handle.config);
      runOptions.maxIterations = 1;
      const result = await handle.service.runTask(runOptions);
      const trace = handle.service.traceTask(result.task.taskId);

      expect(result.task.status).toBe("succeeded");
      expect(result.output).toBe("Summary with ignored tool call.");
      expect(trace.some((event) => event.eventType === "no_tools_tool_calls_ignored")).toBe(true);
      expect(handle.service.showTask(result.task.taskId).toolCalls.some((call) => call.toolCallId === "ignored-read")).toBe(false);
    } finally {
      handle.close();
    }
  });

  it("completes implement requests when the model writes files directly", async () => {
    const workspaceRoot = await createWorkflowWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") },
      policyConfig: WORKFLOW_POLICY_CONFIG,
      provider: new ScriptedProvider((input) => {
        const toolMessages = input.messages.filter((message) => message.role === "tool");

        if (toolMessages.length === 0) {
          return toolCallResponse("Writing the requested feature.", [
            {
              input: { content: "feature complete\n", path: "feature.txt" },
              reason: "Create the requested implementation artifact.",
              toolCallId: "write-feature",
              toolName: "write_file"
            }
          ]);
        }
        return finalResponse("Implemented the requested feature.");
      })
    });

    try {
      const runOptions = createDefaultRunOptions("implement the requested feature", workspaceRoot, handle.config);
      runOptions.maxIterations = 4;
      const result = await handle.service.runTask(runOptions);
      const details = handle.service.showTask(result.task.taskId);

      expect(result.task.status).toBe("succeeded");
      expect(await fs.readFile(join(workspaceRoot, "feature.txt"), "utf8")).toBe("feature complete\n");
      expect(details.toolCalls.some((toolCall) => toolCall.toolCallId === "write-feature")).toBe(true);
    } finally {
      handle.close();
    }
  });

  it("does not require file writes before a code-change task can finish", async () => {
    const workspaceRoot = await createWorkflowWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") },
      policyConfig: WORKFLOW_POLICY_CONFIG,
      provider: new ScriptedProvider(() => finalResponse("No files were changed in this run. The code already works."))
    });

    try {
      const runOptions = createDefaultRunOptions("implement the requested feature", workspaceRoot, handle.config);
      runOptions.maxIterations = 4;
      const result = await handle.service.runTask(runOptions);

      expect(result.task.status).toBe("succeeded");
      expect(result.error).toBeUndefined();
      await expect(fs.readFile(join(workspaceRoot, "feature.txt"), "utf8")).rejects.toThrow();
    } finally {
      handle.close();
    }
  });

  it("does not force workspace changes for modification prompts answered in text", async () => {
    const workspaceRoot = await createWorkflowWorkspace();
    let sawIntentGuard = false;
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") },
      policyConfig: WORKFLOW_POLICY_CONFIG,
      provider: new ScriptedProvider((input) => {
        sawIntentGuard =
          sawIntentGuard ||
          input.messages.some((message) => message.content.includes("Intent fulfillment guard"));
        return finalResponse("Here is another bug list without changing files.");
      })
    });

    try {
      const runOptions = createDefaultRunOptions("修复严重 Bug", workspaceRoot, handle.config);
      runOptions.maxIterations = 4;
      const result = await handle.service.runTask(runOptions);

      expect(sawIntentGuard).toBe(false);
      expect(result.task.status).toBe("succeeded");
      expect(await fs.readFile(join(workspaceRoot, "check.js"), "utf8")).toBe("process.exit(1);\n");
    } finally {
      handle.close();
    }
  });

  it("guards code-change finals until verification runs", async () => {
    const workspaceRoot = await createWorkflowWorkspace();
    let sawVerificationGuard = false;
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
          testCommands: [
            {
              category: "test",
              command: "node check.js",
              name: "test"
            }
          ]
        }
      },
      policyConfig: WORKFLOW_POLICY_CONFIG,
      provider: new ScriptedProvider((input) => {
        const toolMessages = input.messages.filter((message) => message.role === "tool");
        sawVerificationGuard =
          sawVerificationGuard ||
          input.messages.some((message) => message.content.includes("Completion verification required"));
        if (toolMessages.length === 0) {
          return toolCallResponse("Patch the check first.", [
            {
              input: {
                action: "update_file",
                newText: "process.exit(0);\n",
                path: "check.js",
                targetText: "process.exit(1);\n"
              },
              reason: "Make the check pass.",
              toolCallId: "guard-write",
              toolName: "patch"
            }
          ]);
        }
        if (!sawVerificationGuard) {
          return finalResponse("Implementation complete.");
        }
        if (
          !toolMessages.some(
            (message) =>
              message.content.includes("\"exitCode\":0") ||
              message.content.includes("\"exitCode\": 0") ||
              message.content.includes("\"passed\":true") ||
              message.content.includes("\"passed\": true")
          )
        ) {
          return toolCallResponse("Run verification before final.", [
            {
              input: {
                command: "npm test"
              },
              reason: "Satisfy completion verification.",
              toolCallId: "guard-test",
              toolName: "shell"
            }
          ]);
        }
        return finalResponse("Implementation complete and verified.");
      })
    });

    try {
      const runOptions = createDefaultRunOptions("implement and verify the check", workspaceRoot, handle.config);
      runOptions.maxIterations = 10;
      const result = await handle.service.runTask(runOptions);
      const trace = handle.service.traceTask(result.task.taskId);

      expect(result.task.status).toBe("succeeded");
      expect(result.output).toContain("verified");
      expect(sawVerificationGuard).toBe(true);
      expect(trace.some((event) => event.eventType === "completion_verification_missing")).toBe(true);
      expect(trace.some((event) => event.eventType === "completion_verification_satisfied")).toBe(true);
    } finally {
      handle.close();
    }
  });

  it("allows code-change finals that explicitly report unverified work", async () => {
    const workspaceRoot = await createWorkflowWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") },
      policyConfig: WORKFLOW_POLICY_CONFIG,
      provider: new ScriptedProvider((input) => {
        const toolMessages = input.messages.filter((message) => message.role === "tool");
        if (toolMessages.length === 0) {
          return toolCallResponse("Write the change.", [
            {
              input: { content: "changed\n", path: "unverified.txt" },
              reason: "Create the requested file.",
              toolCallId: "unverified-write",
              toolName: "write_file"
            }
          ]);
        }
        return finalResponse("Change complete. Unverified: no configured verification command was available for this file-only update.");
      })
    });

    try {
      const runOptions = createDefaultRunOptions("write a file and explain verification", workspaceRoot, handle.config);
      runOptions.maxIterations = 4;
      const result = await handle.service.runTask(runOptions);
      const trace = handle.service.traceTask(result.task.taskId);

      expect(result.task.status).toBe("succeeded");
      expect(result.output).toContain("Unverified");
      expect(trace.some((event) => event.eventType === "completion_verification_missing")).toBe(true);
    } finally {
      handle.close();
    }
  });

  it("allows read-only tasks to finish without file writes", async () => {
    const workspaceRoot = await createWorkflowWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") },
      policyConfig: WORKFLOW_POLICY_CONFIG,
      provider: new ScriptedProvider(() => finalResponse("I inspected the workspace and summarized the files."))
    });

    try {
      const runOptions = createDefaultRunOptions("inspect and summarize the workspace", workspaceRoot, handle.config);
      runOptions.maxIterations = 2;
      const result = await handle.service.runTask(runOptions);

      expect(result.task.status).toBe("succeeded");
      expect(result.output).toContain("inspected");
    } finally {
      handle.close();
    }
  });

  it("keeps mutation tools visible for unfinished implementation status questions", async () => {
    const workspaceRoot = await createWorkflowWorkspace();
    const seenToolPlans: string[][] = [];
    const prompt =
      "\u7b2c\u4e09\u9636\u6bb5\u8fd8\u6709\u54ea\u4e9b\u6ca1\u5b9e\u73b0\u5b8c\u6bd5";
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") },
      policyConfig: WORKFLOW_POLICY_CONFIG,
      provider: new ScriptedProvider((input) => {
        seenToolPlans.push(input.availableTools.map((tool) => tool.name));
        return finalResponse("phase three still has unfinished implementation items.");
      })
    });

    try {
      const runOptions = createDefaultRunOptions(prompt, workspaceRoot, handle.config);
      runOptions.maxIterations = 2;
      const result = await handle.service.runTask(runOptions);

      expect(result.task.status).toBe("succeeded");
      expect(result.output).toContain("phase three");
      expect(seenToolPlans).toHaveLength(1);
      expect(seenToolPlans[0]).toContain("read_file");
      expect(seenToolPlans[0]).toContain("write_file");
    } finally {
      handle.close();
    }
  });

  it("exposes write tools for start-from implementation prompts", async () => {
    const workspaceRoot = await createWorkflowWorkspace();
    const seenToolPlans: string[][] = [];
    const prompt = "\u5148\u4ece\u6dfb\u52a0\u52a8\u753b\u6548\u679c\u5f00\u59cb";
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") },
      policyConfig: WORKFLOW_POLICY_CONFIG,
      provider: new ScriptedProvider((input) => {
        seenToolPlans.push(input.availableTools.map((tool) => tool.name));
        const toolMessages = input.messages.filter((message) => message.role === "tool");
        if (toolMessages.length === 0) {
          return toolCallResponse("Add the animation effect file.", [
            {
              input: { content: "animation enabled\n", path: "animation.txt" },
              reason: "The user explicitly asked to start adding animation effects.",
              toolCallId: "write-animation-start",
              toolName: "write_file"
            }
          ]);
        }
        return finalResponse("Animation work started.");
      })
    });

    try {
      const runOptions = createDefaultRunOptions(prompt, workspaceRoot, handle.config);
      runOptions.maxIterations = 4;
      const result = await handle.service.runTask(runOptions);

      expect(result.task.status).toBe("succeeded");
      expect(result.output).toContain("Animation work started");
      expect(seenToolPlans[0]).toContain("write_file");
      expect(await fs.readFile(join(workspaceRoot, "animation.txt"), "utf8")).toBe(
        "animation enabled\n"
      );
    } finally {
      handle.close();
    }
  });

  it("keeps mutation tools visible for next-stage analysis questions", async () => {
    const workspaceRoot = await createWorkflowWorkspace();
    const seenToolPlans: string[][] = [];
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") },
      policyConfig: WORKFLOW_POLICY_CONFIG,
      provider: new ScriptedProvider((input) => {
        seenToolPlans.push(input.availableTools.map((tool) => tool.name));
        return finalResponse("下一步应该先确认开发文档里的阶段边界。");
      })
    });

    try {
      const runOptions = createDefaultRunOptions("那接下来该开发文档里的哪个阶段了？", workspaceRoot, handle.config);
      runOptions.maxIterations = 2;
      const result = await handle.service.runTask(runOptions);

      expect(result.task.status).toBe("succeeded");
      expect(seenToolPlans).toHaveLength(1);
      expect(seenToolPlans[0]).toContain("read_file");
      expect(seenToolPlans[0]).toContain("write_file");
    } finally {
      handle.close();
    }
  });

  it("blocks mutation tool calls for the planner profile through policy", async () => {
    const workspaceRoot = await createWorkflowWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") },
      policyConfig: {
        ...WORKFLOW_POLICY_CONFIG,
        rules: [
          {
            description: "Deny planner writes in this workflow test.",
            effect: "deny",
            id: "deny-planner-write",
            match: {
              agentProfiles: ["planner"],
              capabilities: ["filesystem.write"]
            },
            priority: 110
          },
          ...WORKFLOW_POLICY_CONFIG.rules
        ]
      },
      provider: new ScriptedProvider((input) => {
        const toolMessages = input.messages.filter((message) => message.role === "tool");
        if (toolMessages.length > 0) {
          return finalResponse("I cannot write files in planner mode.");
        }
        return toolCallResponse("Trying to write despite read-only mode.", [
          {
            input: { content: "should not be written\n", path: "PROGRESS.md" },
            reason: "This call should be blocked by planner policy.",
            toolCallId: "blocked-read-only-write",
            toolName: "write_file"
          }
        ]);
      })
    });

    try {
      const runOptions = createDefaultRunOptions("那接下来该开发文档里的哪个阶段了？", workspaceRoot, handle.config);
      runOptions.maxIterations = 4;
      runOptions.agentProfileId = "planner";
      const result = await handle.service.runTask(runOptions);
      const details = handle.service.showTask(result.task.taskId);
      const blockedWrite = details.toolCalls.find((toolCall) => toolCall.toolCallId === "blocked-read-only-write");

      expect(result.task.status).toBe("succeeded");
      expect(result.error).toBeUndefined();
      expect(blockedWrite?.status).toBe("failed");
      expect(blockedWrite?.errorCode).toBe("policy_denied");
      await expect(fs.readFile(join(workspaceRoot, "PROGRESS.md"), "utf8")).rejects.toThrow();
    } finally {
      handle.close();
    }
  });

  it("allows ambiguous repair questions to use agent-mode write tools", async () => {
    const workspaceRoot = await createWorkflowWorkspace();
    const seenToolPlans: string[][] = [];
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") },
      policyConfig: WORKFLOW_POLICY_CONFIG,
      provider: new ScriptedProvider((input) => {
        seenToolPlans.push(input.availableTools.map((tool) => tool.name));
        const toolMessages = input.messages.filter((message) => message.role === "tool");
        if (toolMessages.length > 0) {
          return finalResponse("The write completed in agent mode.");
        }
        return toolCallResponse("Trying to repair an ambiguous question.", [
          {
            input: { content: "should not be written\n", path: "ambiguous.txt" },
            reason: "Agent mode leaves mutation decisions to policy.",
            toolCallId: "blocked-ambiguous-write",
            toolName: "write_file"
          }
        ]);
      })
    });

    try {
      const runOptions = createDefaultRunOptions("\u8fd9\u4e2a\u80fd\u4fee\u5417", workspaceRoot, handle.config);
      runOptions.maxIterations = 4;
      const result = await handle.service.runTask(runOptions);
      const details = handle.service.showTask(result.task.taskId);
      const blockedWrite = details.toolCalls.find((toolCall) => toolCall.toolCallId === "blocked-ambiguous-write");

      expect(result.task.status).toBe("succeeded");
      expect(seenToolPlans[0]).toContain("read_file");
      expect(seenToolPlans[0]).toContain("write_file");
      expect(blockedWrite?.status).toBe("finished");
      expect(await fs.readFile(join(workspaceRoot, "ambiguous.txt"), "utf8")).toBe("should not be written\n");
    } finally {
      handle.close();
    }
  });

  it("feeds missing file read errors back to the model instead of failing the task", async () => {
    const workspaceRoot = await createWorkflowWorkspace();
    await fs.mkdir(join(workspaceRoot, "css"), { recursive: true });
    await fs.writeFile(join(workspaceRoot, "css", "style.css"), "body { color: green; }\n", "utf8");
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") },
      policyConfig: WORKFLOW_POLICY_CONFIG,
      provider: new ScriptedProvider((input) => {
        const toolMessages = input.messages.filter((message) => message.role === "tool");
        const lastToolMessage = toolMessages.at(-1)?.content ?? "";
        if (toolMessages.length === 0) {
          return toolCallResponse("Check the stylesheet.", [
            {
              input: { path: "style.css" },
              reason: "Try the stylesheet path from memory.",
              toolCallId: "read-missing-style",
              toolName: "read_file"
            }
          ]);
        }
        if (lastToolMessage.includes("ENOENT") || lastToolMessage.includes("errorCode")) {
          return toolCallResponse("Correct the stylesheet path.", [
            {
              input: { path: "css/style.css" },
              reason: "Use the path referenced by index.html.",
              toolCallId: "read-real-style",
              toolName: "read_file"
            }
          ]);
        }
        return finalResponse("Recovered from the missing file read and inspected css/style.css.");
      })
    });

    try {
      const runOptions = createDefaultRunOptions("inspect the stylesheet", workspaceRoot, handle.config);
      runOptions.maxIterations = 5;
      const result = await handle.service.runTask(runOptions);
      const details = handle.service.showTask(result.task.taskId);

      expect(result.task.status).toBe("succeeded");
      expect(result.output).toContain("Recovered");
      expect(details.toolCalls.find((call) => call.toolCallId === "read-missing-style")?.status).toBe("failed");
      expect(details.toolCalls.find((call) => call.toolCallId === "read-real-style")?.status).toBe("finished");
      expect(details.trace.some((event) => event.eventType === "tool_call_failed")).toBe(true);
    } finally {
      handle.close();
    }
  });

  it("feeds failed file writes back to the model so it can re-read and retry", async () => {
    const workspaceRoot = await createWorkflowWorkspace();
    await fs.writeFile(join(workspaceRoot, "config.js"), "const color = 'green';\n", "utf8");
    let sawRecoverableWriteFailure = false;
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") },
      policyConfig: WORKFLOW_POLICY_CONFIG,
      provider: new ScriptedProvider((input) => {
        const toolMessages = input.messages.filter((message) => message.role === "tool");
        const lastToolMessage = toolMessages.at(-1)?.content ?? "";
        if (toolMessages.length === 0) {
          return toolCallResponse("Try updating the remembered color target.", [
            {
              input: {
                action: "update_file",
                newText: "const color = 'blue';\n",
                path: "config.js",
                targetText: "const background = 'green';\n"
              },
              reason: "Use the target text remembered from context.",
              toolCallId: "write-stale-target",
              toolName: "patch"
            }
          ]);
        }
        if (lastToolMessage.includes("recoverable") && lastToolMessage.includes("Target text")) {
          sawRecoverableWriteFailure = true;
          return toolCallResponse("Retry with the current file contents.", [
            {
              input: {
                action: "update_file",
                newText: "const color = 'blue';\n",
                path: "config.js",
                targetText: "const color = 'green';\n"
              },
              reason: "The previous write_file result showed the real target text.",
              toolCallId: "write-current-target",
              toolName: "patch"
            }
          ]);
        }
        return finalResponse("Recovered from the stale write target and updated config.js.");
      })
    });

    try {
      const runOptions = createDefaultRunOptions("update the config color", workspaceRoot, handle.config);
      runOptions.maxIterations = 5;
      const result = await handle.service.runTask(runOptions);
      const details = handle.service.showTask(result.task.taskId);

      expect(result.task.status).toBe("succeeded");
      expect(result.output).toContain("Recovered");
      expect(sawRecoverableWriteFailure).toBe(true);
      expect(await fs.readFile(join(workspaceRoot, "config.js"), "utf8")).toBe("const color = 'blue';\n");
      expect(details.toolCalls.find((call) => call.toolCallId === "write-stale-target")?.status).toBe("failed");
      expect(details.toolCalls.find((call) => call.toolCallId === "write-current-target")?.status).toBe("finished");
      expect(details.trace.some((event) => event.eventType === "tool_call_failed")).toBe(true);
    } finally {
      handle.close();
    }
  });

  it("completes successfully when verification already passed at the iteration limit", async () => {
    const workspaceRoot = await createWorkflowWorkspace();
    let noToolsSummaryRequested = false;
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") },
      policyConfig: WORKFLOW_POLICY_CONFIG,
      provider: new ScriptedProvider((input) => {
        if (input.availableTools.length === 0) {
          noToolsSummaryRequested = true;
          return finalResponse("should not be required");
        }
        const toolMessages = input.messages.filter((message) => message.role === "tool");
        if (toolMessages.length === 0) {
          return toolCallResponse("Fix the check script.", [
            {
              input: { content: "process.exit(0);\n", overwrite: true, path: "check.js" },
              reason: "Make verification pass.",
              toolCallId: "write-check",
              toolName: "write_file"
            }
          ]);
        }
        if (toolMessages.some((message) => (message.toolCallId ?? "").includes("write-check"))) {
          const alreadyVerified = toolMessages.some((message) => (message.toolCallId ?? "").includes("verify-check"));
          if (!alreadyVerified) {
            return toolCallResponse("Verify the workspace change.", [
              {
                input: { command: "node check.js" },
                reason: "Run configured verification.",
                toolCallId: "verify-check",
                toolName: "shell"
              }
            ]);
          }
        }
        return toolCallResponse("Keep looking after verification.", [
          {
            input: { path: "package.json" },
            reason: "Extra read after verification.",
            toolCallId: `read-after-${input.iteration}`,
            toolName: "read_file"
          }
        ]);
      })
    });

    try {
      const runOptions = createDefaultRunOptions("repair and verify then keep going", workspaceRoot, handle.config);
      runOptions.maxIterations = 3;
      const result = await handle.service.runTask(runOptions);
      const details = handle.service.showTask(result.task.taskId);

      expect(noToolsSummaryRequested).toBe(false);
      expect(result.task.status).toBe("succeeded");
      expect(details.trace.some((event) => event.eventType === "completion_verification_satisfied")).toBe(true);
      expect(details.trace.some((event) => event.eventType === "iteration_exhausted")).toBe(false);
    } finally {
      handle.close();
    }
  });

});

async function createWorkflowWorkspace(): Promise<string> {
  const tempRoot = join(process.cwd(), ".tmp-tests");
  await fs.mkdir(tempRoot, { recursive: true });
  const workspaceRoot = await fs.mkdtemp(join(tempRoot, "auto-talon-workflow-loop-"));
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
