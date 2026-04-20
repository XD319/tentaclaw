import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createApplication, createDefaultRunOptions } from "../runtime";
import {
  requireProviderManifest,
  resolveDefaultProviderSettings,
  type ResolvedProviderConfig,
  type SupportedProviderName
} from "../providers";
import type {
  AgentProfileId,
  ApprovalRecord,
  AuditLogRecord,
  Provider,
  RuntimeErrorCode,
  TaskRecord,
  ToolCallRecord,
  TraceEvent
} from "../types";
import { loadSmokeTaskFixtures, type SmokeTaskFixture } from "./smoke-fixtures";
import { ScriptedSmokeProvider } from "./smoke-provider";

export interface SmokeHarnessOptions {
  autoApprove?: boolean;
  fixturePath?: string;
  providerName?: SupportedProviderName | "scripted-smoke";
  taskIds?: string[];
}

export interface SmokeTraceCheckResult {
  explanation: string;
  ok: boolean;
  requirement: string;
}

export interface SmokeTaskRunResult {
  approvalsTriggered: number;
  auditLogCount: number;
  durationMs: number;
  failureReason: string | null;
  keyTraceSummary: string[];
  memoryLeakDetected: boolean;
  modelName: string | null;
  output: string | null;
  success: boolean;
  taskFixture: SmokeTaskFixture;
  taskId: string;
  tokenUsage: {
    cachedInputTokens: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  totalRounds: number;
  traceChecks: SmokeTraceCheckResult[];
  traceEventCount: number;
  toolCallSuccessRate: number;
}

export interface SmokeSuiteReport {
  approvalTriggerCount: number;
  averageDurationMs: number;
  averageRounds: number;
  failureReasons: Record<string, number>;
  failedCount: number;
  modelName: string | null;
  providerName: string;
  results: SmokeTaskRunResult[];
  succeededCount: number;
  taskCount: number;
  toolCallSuccessRate: number;
}

interface TaskExecutionSnapshot {
  approvals: ApprovalRecord[];
  auditLogs: AuditLogRecord[];
  output: string | null;
  task: TaskRecord;
  toolCalls: ToolCallRecord[];
  trace: TraceEvent[];
}

export async function runSmokeSuite(options: SmokeHarnessOptions = {}): Promise<SmokeSuiteReport> {
  const fixtures = selectFixtures(loadSmokeTaskFixtures(options.fixturePath), options.taskIds);
  const providerName = options.providerName ?? "scripted-smoke";
  const results: SmokeTaskRunResult[] = [];

  for (const taskFixture of fixtures) {
    results.push(
      await runSmokeTask(taskFixture, {
        autoApprove: options.autoApprove ?? true,
        providerName
      })
    );
  }

  const succeededCount = results.filter((result) => result.success).length;
  const failedCount = results.length - succeededCount;
  const approvalTriggerCount = results.reduce((sum, result) => sum + result.approvalsTriggered, 0);
  const failureReasons = results.reduce<Record<string, number>>((counts, result) => {
    if (result.failureReason === null) {
      return counts;
    }

    counts[result.failureReason] = (counts[result.failureReason] ?? 0) + 1;
    return counts;
  }, {});

  return {
    approvalTriggerCount,
    averageDurationMs: average(results.map((result) => result.durationMs)),
    averageRounds: average(results.map((result) => result.totalRounds)),
    failedCount,
    failureReasons,
    modelName: results.find((result) => result.modelName !== null)?.modelName ?? null,
    providerName,
    results,
    succeededCount,
    taskCount: results.length,
    toolCallSuccessRate: average(results.map((result) => result.toolCallSuccessRate))
  };
}

export function formatSmokeSuiteReport(report: SmokeSuiteReport): string {
  const lines = [
    `Provider: ${report.providerName}`,
    `Model: ${report.modelName ?? "-"}`,
    `Total tasks: ${report.taskCount}`,
    `Succeeded: ${report.succeededCount}`,
    `Failed: ${report.failedCount}`,
    `Average rounds: ${report.averageRounds.toFixed(2)}`,
    `Average duration: ${report.averageDurationMs.toFixed(1)}ms`,
    `Approval triggers: ${report.approvalTriggerCount}`,
    `Tool call success rate: ${(report.toolCallSuccessRate * 100).toFixed(1)}%`,
    `Failure reasons: ${formatFailureReasons(report.failureReasons)}`,
    ""
  ];

  for (const result of report.results) {
    lines.push(`- ${result.taskFixture.taskId}`);
    lines.push(`  taskId=${result.taskId}`);
    lines.push(`  success=${result.success}`);
    lines.push(`  durationMs=${result.durationMs}`);
    lines.push(`  rounds=${result.totalRounds}`);
    lines.push(`  approvals=${result.approvalsTriggered}`);
    lines.push(`  toolCallSuccessRate=${(result.toolCallSuccessRate * 100).toFixed(1)}%`);
    lines.push(`  failureReason=${result.failureReason ?? "none"}`);
    lines.push(`  trace=${result.keyTraceSummary.join(" | ")}`);
  }

  return lines.join("\n");
}

export async function runSmokeTask(
  taskFixture: SmokeTaskFixture,
  options: {
    autoApprove: boolean;
    providerName: SupportedProviderName | "scripted-smoke";
  }
): Promise<SmokeTaskRunResult> {
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), `auto-talon-smoke-${taskFixture.taskId}-`));
  await seedWorkspace(workspaceRoot);

  const provider = createHarnessProvider(options.providerName);
  const runtimeProviderName = options.providerName === "scripted-smoke" ? "mock" : options.providerName;
  const createOptions = {
    config: {
      databasePath: ":memory:",
      provider: createSmokeProviderConfig(runtimeProviderName),
      workspaceRoot
    }
  };
  const handle =
    provider === undefined
      ? createApplication(workspaceRoot, createOptions)
      : createApplication(workspaceRoot, {
          ...createOptions,
          provider
        });

  try {
    if (taskFixture.taskId === "long_memory_recall_followup") {
      await seedProjectMemory(handle.config, handle.service, workspaceRoot);
    }

    const snapshot = await executeTask(handle.config, handle.service, {
      autoApprove: options.autoApprove,
      profile: taskFixture.profile,
      smokeTaskId: taskFixture.scriptId,
      taskInput: taskFixture.input,
      workspaceRoot
    });

    const evaluation = await evaluateTaskResult(taskFixture, workspaceRoot, snapshot);

    return {
      approvalsTriggered: snapshot.approvals.length,
      auditLogCount: snapshot.auditLogs.length,
      durationMs: computeDuration(snapshot.task),
      failureReason: evaluation.failureReason,
      keyTraceSummary: summarizeTrace(snapshot.trace),
      memoryLeakDetected: detectRestrictedMemoryLeak(snapshot.trace),
      modelName: detectModelName(snapshot.trace),
      output: snapshot.output,
      success: evaluation.success,
      taskFixture,
      taskId: snapshot.task.taskId,
      tokenUsage: computeTokenUsage(snapshot.trace),
      totalRounds: snapshot.task.currentIteration,
      traceChecks: evaluation.traceChecks,
      traceEventCount: snapshot.trace.length,
      toolCallSuccessRate: computeToolCallSuccessRate(snapshot.toolCalls)
    };
  } finally {
    handle.close();
    await fs.rm(workspaceRoot, { force: true, recursive: true });
  }
}

async function executeTask(
  config: ReturnType<typeof createApplication>["config"],
  service: ReturnType<typeof createApplication>["service"],
  input: {
    autoApprove: boolean;
    profile: AgentProfileId;
    smokeTaskId: string;
    taskInput: string;
    workspaceRoot: string;
  }
): Promise<TaskExecutionSnapshot> {
  const runOptions = createDefaultRunOptions(input.taskInput, input.workspaceRoot, config);
  runOptions.agentProfileId = input.profile;
  runOptions.metadata = {
    smokeTaskId: input.smokeTaskId
  };
  runOptions.userId = "smoke-harness";

  let result = await service.runTask(runOptions);
  while (result.task.status === "waiting_approval" && input.autoApprove) {
    const pending = service.listPendingApprovals()[0];
    if (pending === undefined) {
      break;
    }

    const approvalResult = await service.resolveApproval(
      pending.approvalId,
      "allow",
      "smoke-harness"
    );
    result = {
      output: approvalResult.output,
      task: approvalResult.task
    };
  }

  const details = service.showTask(result.task.taskId);
  return {
    approvals: details.approvals,
    auditLogs: service.auditTask(result.task.taskId),
    output: result.output,
    task: details.task ?? result.task,
    toolCalls: details.toolCalls,
    trace: details.trace
  };
}

async function evaluateTaskResult(
  taskFixture: SmokeTaskFixture,
  workspaceRoot: string,
  snapshot: TaskExecutionSnapshot
): Promise<{
  failureReason: string | null;
  success: boolean;
  traceChecks: SmokeTraceCheckResult[];
}> {
  const traceChecks = evaluateTraceExpectations(taskFixture, snapshot.trace);
  const traceFailure = traceChecks.find((check) => !check.ok);
  if (traceFailure !== undefined) {
    return {
      failureReason: `trace:${traceFailure.requirement}`,
      success: false,
      traceChecks
    };
  }

  if (snapshot.task.status !== "succeeded") {
    return {
      failureReason: classifyFailure(snapshot.task.errorCode),
      success: false,
      traceChecks
    };
  }

  const taskFailure = await evaluateScenarioFiles(taskFixture.taskId, workspaceRoot, snapshot);
  return {
    failureReason: taskFailure,
    success: taskFailure === null,
    traceChecks
  };
}

function evaluateTraceExpectations(
  taskFixture: SmokeTaskFixture,
  trace: TraceEvent[]
): SmokeTraceCheckResult[] {
  const expectations = taskFixture.traceExpectations;
  const toolRequests = trace.filter((event) => event.eventType === "tool_call_requested");
  const toolFinishes = trace.filter((event) => event.eventType === "tool_call_finished");

  const checks: SmokeTraceCheckResult[] = [];
  checks.push({
    explanation: "task_created payload contains the input goal.",
    ok:
      !expectations.mustExplainGoal ||
      trace.some(
        (event) =>
          event.eventType === "task_created" &&
          typeof event.payload.input === "string" &&
          event.payload.input.length > 0
      ),
    requirement: "goal_visible"
  });
  checks.push({
    explanation: "Every requested tool call should carry a non-empty reason.",
    ok:
      !expectations.mustExplainToolReason ||
      (toolRequests.length > 0 &&
        toolRequests.every(
          (event) =>
            typeof event.payload.reason === "string" && event.payload.reason.trim().length > 0
        )),
    requirement: "tool_reason_visible"
  });
  checks.push({
    explanation: "Finished tool calls should expose a summary/output preview.",
    ok:
      !expectations.mustSummarizeToolResults ||
      (toolFinishes.length > 0 &&
        toolFinishes.every(
          (event) =>
            typeof event.payload.summary === "string" &&
            event.payload.summary.length > 0 &&
            typeof event.payload.outputPreview === "string"
        )),
    requirement: "tool_result_summary_visible"
  });
  checks.push({
    explanation: "Trace should show why the runtime continued or stopped.",
    ok:
      !expectations.mustExplainContinuation ||
      (trace.some((event) => event.eventType === "loop_iteration_completed") &&
        trace.some((event) => event.eventType === "final_outcome")),
    requirement: "continue_stop_visible"
  });
  checks.push({
    explanation: "Memory recall should be visible when expected.",
    ok:
      !expectations.expectMemoryRecall ||
      trace.some(
        (event) =>
          event.eventType === "memory_recalled" &&
          Array.isArray(event.payload.selectedMemoryIds) &&
          event.payload.selectedMemoryIds.length > 0
      ),
    requirement: "memory_recall_visible"
  });
  checks.push({
    explanation: "Approval trace should be visible when expected.",
    ok:
      !expectations.expectApproval ||
      (trace.some((event) => event.eventType === "approval_requested") &&
        trace.some((event) => event.eventType === "approval_resolved")),
    requirement: "approval_visible"
  });
  checks.push({
    explanation: "Policy trace should be visible when expected.",
    ok:
      !expectations.expectPolicyTrace ||
      trace.some((event) => event.eventType === "policy_decision"),
    requirement: "policy_visible"
  });
  checks.push({
    explanation: "Session compact should be visible when expected.",
    ok:
      !expectations.expectSessionCompact ||
      trace.some((event) => event.eventType === "session_compacted"),
    requirement: "session_compact_visible"
  });

  return checks;
}

async function evaluateScenarioFiles(
  taskId: string,
  workspaceRoot: string,
  snapshot: TaskExecutionSnapshot
): Promise<string | null> {
  switch (taskId) {
    case "single_generate_file": {
      const content = await fs.readFile(join(workspaceRoot, "docs/generated/release-note.md"), "utf8");
      return content.includes("Release Note") ? null : "missing_release_note_content";
    }

    case "single_update_config": {
      const content = await fs.readFile(join(workspaceRoot, "config/app.json"), "utf8");
      return content.includes("\"featureFlag\": true") ? null : "feature_flag_not_updated";
    }

    case "multi_read_then_plan_write": {
      const content = await fs.readFile(join(workspaceRoot, "docs/runtime-overview.md"), "utf8");
      return content.includes("Runtime Overview") ? null : "overview_not_created";
    }

    case "multi_write_then_verify": {
      const content = await fs.readFile(join(workspaceRoot, "config/feature.flag.json"), "utf8");
      return content.includes("\"enabled\": true") ? null : "feature_flag_file_invalid";
    }

    case "multi_fix_after_failed_verification": {
      const content = await fs.readFile(join(workspaceRoot, "config/verification.txt"), "utf8");
      return content.includes("PASS") ? null : "verification_not_fixed";
    }

    case "multi_search_patch_verify": {
      const content = await fs.readFile(join(workspaceRoot, "src/app.ts"), "utf8");
      return content.includes("TODO: clean up bootstrap") ? "todo_not_removed" : null;
    }

    case "single_run_shell":
      return snapshot.output?.includes("whoami returned") === true ? null : "shell_output_not_explained";

    case "long_memory_recall_followup":
      return snapshot.output?.includes("[project] Task outcome") === true
        ? null
        : "memory_recall_not_reflected";

    default:
      return snapshot.task.status === "succeeded" ? null : "task_not_succeeded";
  }
}

async function seedProjectMemory(
  config: ReturnType<typeof createApplication>["config"],
  service: ReturnType<typeof createApplication>["service"],
  workspaceRoot: string
): Promise<void> {
  const runOptions = createDefaultRunOptions(
    "Seed project memory for smoke recall.",
    workspaceRoot,
    config
  );
  runOptions.metadata = {
    smokeTaskId: "memory_seed_project"
  };
  runOptions.userId = "smoke-harness";
  const seed = await service.runTask(runOptions);
  if (seed.task.status !== "succeeded") {
    throw new Error("Failed to seed project memory for smoke recall.");
  }
}

async function seedWorkspace(workspaceRoot: string): Promise<void> {
  await fs.mkdir(join(workspaceRoot, "config"), { recursive: true });
  await fs.mkdir(join(workspaceRoot, "docs/generated"), { recursive: true });
  await fs.mkdir(join(workspaceRoot, "src"), { recursive: true });

  await fs.writeFile(
    join(workspaceRoot, "README.md"),
    "# Auto Talon Fixture\n\nThis workspace is used to verify runtime smoke tasks.\nRun build and test through the local runtime flow.\n",
    "utf8"
  );
  await fs.writeFile(
    join(workspaceRoot, "package.json"),
    JSON.stringify(
      {
        description: "Fixture workspace for runtime smoke tests",
        name: "auto-talon-fixture",
        private: true,
        scripts: {
          build: "tsc -p tsconfig.json",
          test: "vitest run"
        },
        version: "0.0.1"
      },
      null,
      2
    ),
    "utf8"
  );
  await fs.writeFile(
    join(workspaceRoot, "config/app.json"),
    "{\n  \"featureFlag\": false,\n  \"mode\": \"safe\"\n}\n",
    "utf8"
  );
  await fs.writeFile(
    join(workspaceRoot, "src/app.ts"),
    "export function bootstrap(): string {\n  return \"TODO: clean up bootstrap\";\n}\n",
    "utf8"
  );
  await fs.writeFile(
    join(workspaceRoot, "src/runtime.ts"),
    "export function runRuntimeTask(input: string): string {\n  return `runtime:${input}`;\n}\n",
    "utf8"
  );
}

function selectFixtures(fixtures: SmokeTaskFixture[], taskIds: string[] | undefined): SmokeTaskFixture[] {
  if (taskIds === undefined || taskIds.length === 0) {
    return fixtures;
  }

  const requested = new Set(taskIds);
  return fixtures.filter((fixture) => requested.has(fixture.taskId));
}

function createHarnessProvider(
  providerName: SupportedProviderName | "scripted-smoke"
): Provider | undefined {
  if (providerName === "scripted-smoke") {
    return new ScriptedSmokeProvider();
  }

  return undefined;
}

function createSmokeProviderConfig(providerName: SupportedProviderName): ResolvedProviderConfig {
  const manifest = requireProviderManifest(providerName);
  const defaults = resolveDefaultProviderSettings(providerName);

  const providerLabel =
    manifest.transport === "anthropic-compatible"
      ? manifest.anthropicCompatible?.providerLabel ?? null
      : manifest.openAiCompatible?.providerLabel ?? null;
  const anthropicVersion =
    manifest.transport === "anthropic-compatible"
      ? manifest.anthropicCompatible?.anthropicVersion ?? null
      : null;

  return {
    ...defaults,
    anthropicVersion,
    builtinProviderName: providerName,
    configPath: "<smoke-harness>",
    configSource: "defaults",
    displayName: manifest.displayName,
    family: manifest.family,
    name: providerName,
    providerLabel,
    transport: manifest.transport
  };
}

function summarizeTrace(trace: TraceEvent[]): string[] {
  const interesting = trace.filter((event) =>
    [
      "task_created",
      "model_response",
      "policy_decision",
      "tool_call_requested",
      "tool_call_finished",
      "approval_requested",
      "approval_resolved",
      "memory_recalled",
      "session_compacted",
      "final_outcome"
    ].includes(event.eventType)
  );
  const selected = [
    ...interesting.slice(0, 5),
    ...interesting.filter(
      (event) =>
        event.eventType === "approval_requested" ||
        event.eventType === "approval_resolved" ||
        event.eventType === "session_compacted" ||
        event.eventType === "final_outcome"
    )
  ];

  return [...new Map(selected.map((event) => [event.eventId, event])).values()].map(
    (event) => `${event.eventType}:${event.summary}`
  );
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function computeDuration(task: TaskRecord): number {
  if (task.startedAt === null || task.finishedAt === null) {
    return 0;
  }

  return Math.max(0, Date.parse(task.finishedAt) - Date.parse(task.startedAt));
}

function computeToolCallSuccessRate(toolCalls: ToolCallRecord[]): number {
  if (toolCalls.length === 0) {
    return 1;
  }

  const finishedCount = toolCalls.filter((toolCall) => toolCall.status === "finished").length;
  return finishedCount / toolCalls.length;
}

function computeTokenUsage(trace: TraceEvent[]): {
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
  return trace.reduce(
    (accumulator, event) => {
      if (event.eventType !== "provider_request_succeeded") {
        return accumulator;
      }

      const usage = event.payload.usage;
      const inputTokens = typeof usage?.inputTokens === "number" ? usage.inputTokens : 0;
      const outputTokens = typeof usage?.outputTokens === "number" ? usage.outputTokens : 0;
      const totalTokens =
        typeof usage?.totalTokens === "number" ? usage.totalTokens : inputTokens + outputTokens;
      const cachedInputTokens =
        typeof usage?.cachedInputTokens === "number" ? usage.cachedInputTokens : 0;

      return {
        cachedInputTokens: accumulator.cachedInputTokens + cachedInputTokens,
        inputTokens: accumulator.inputTokens + inputTokens,
        outputTokens: accumulator.outputTokens + outputTokens,
        totalTokens: accumulator.totalTokens + totalTokens
      };
    },
    {
      cachedInputTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    }
  );
}

function detectModelName(trace: TraceEvent[]): string | null {
  const event = [...trace]
    .reverse()
    .find((item) => item.eventType === "provider_request_succeeded");
  return event?.eventType === "provider_request_succeeded" ? event.payload.modelName : null;
}

function detectRestrictedMemoryLeak(trace: TraceEvent[]): boolean {
  return trace.some(
    (event) =>
      event.eventType === "memory_recalled" &&
      event.payload.entries.some(
        (entry) => entry.privacyLevel === "restricted" && entry.selected
      )
  );
}

function classifyFailure(errorCode: RuntimeErrorCode | null): string {
  return errorCode ?? "task_failed";
}

function formatFailureReasons(failureReasons: Record<string, number>): string {
  const entries = Object.entries(failureReasons);
  if (entries.length === 0) {
    return "none";
  }

  return entries.map(([reason, count]) => `${reason}:${count}`).join(", ");
}
