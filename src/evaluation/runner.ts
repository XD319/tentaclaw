import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

import { resolveProviderConfigForProvider } from "../providers/index.js";
import { createApplication, createDefaultRunOptions } from "../runtime/index.js";
import type { Provider, TraceEvent } from "../types/index.js";
import { changedPaths, evaluateScorer } from "./scorers.js";
import { loadEvalSuite, type EvalSuiteManifest, type EvalTask } from "./schema.js";
import { mean, passAtK, passPowerK, percentile, standardError, wilsonInterval } from "./statistics.js";
import type { EvalFailureClassification, EvalRunReport, EvalTaskResult, EvalTrialResult } from "./types.js";

export interface EvalGateThresholds {
  /** Fail the gate when the verification completion rate drops below this. */
  minVerificationCompletionRate?: number;
  /** Fail the gate when the workspace scope violation rate exceeds this. */
  maxWorkspaceScopeViolationRate?: number;
}

export interface CapabilityEvalOptions {
  configCwd?: string;
  gateThresholds?: EvalGateThresholds;
  judge?: Parameters<typeof evaluateScorer>[1]["judge"];
  providerFactory?: () => Provider;
  providerName: string;
  repetitions?: number;
  suitePath: string;
  taskIds?: string[];
  /** Extra workspace files seeded for every trial (not part of the task fixture). */
  workspaceOverlay?: Record<string, string>;
}

export async function runCapabilityEval(options: CapabilityEvalOptions): Promise<EvalRunReport> {
  const repetitions = options.repetitions ?? 3;
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20) {
    throw new Error("Eval repetitions must be an integer between 1 and 20.");
  }
  if (options.providerFactory === undefined && ["scripted-smoke", "mock"].includes(options.providerName)) {
    throw new Error("Capability eval requires a configured real provider; use `talon smoke run` for scripted checks.");
  }
  const suite = loadEvalSuite(options.suitePath);
  const tasks = selectTasks(suite, options.taskIds);
  const configCwd = resolve(options.configCwd ?? process.cwd());
  const providerConfig = resolveProviderConfigForProvider(configCwd, options.providerFactory === undefined ? options.providerName : "mock");
  if (options.providerFactory === undefined && providerConfig.configured === false) {
    throw new Error(`Provider "${options.providerName}" is not configured.`);
  }

  const taskResults: EvalTaskResult[] = [];
  for (const task of tasks) {
    const trials: EvalTrialResult[] = [];
    for (let trial = 1; trial <= repetitions; trial += 1) {
      trials.push(await runTrial(task, trial, providerConfig, options));
    }
    const successes = trials.filter((trial) => trial.success).length;
    taskResults.push({
      passAtK: passAtK(successes, repetitions, repetitions),
      passPowerK: passPowerK(successes, repetitions, repetitions),
      successRate: successes / repetitions,
      task: {
        capabilities: task.capabilities,
        category: task.category,
        difficulty: task.difficulty,
        id: task.id,
        risk: task.risk,
        title: task.title
      },
      trials
    });
  }

  const allTrials = taskResults.flatMap((task) => task.trials);
  const costValues = allTrials.flatMap((trial) => trial.costUsd === null ? [] : [trial.costUsd]);
  const totalCost = costValues.length === 0 ? null : costValues.reduce((total, value) => total + value, 0);
  const successes = allTrials.filter((trial) => trial.success).length;
  const successValues = allTrials.map((trial) => trial.success ? 1 : 0);
  let gateReasons = collectGateReasons(taskResults);
  const totalTokens = sumTokens(allTrials);
  const failureClassificationCounts = countFailureClassifications(allTrials);
  const providerConfigurationFailures = allTrials.filter((trial) => trial.failureClassification === "provider_configuration_failure");
  const valid = providerConfigurationFailures.length === 0;
  if (!valid) gateReasons = [`invalid_run: provider configuration failed in ${providerConfigurationFailures.length} trial(s)`, ...gateReasons];
  const recoveryAttempts = allTrials.filter((trial) => hasTraceEvent(trial.trace, "task_recovery_started"));
  const recoveredTrials = recoveryAttempts.filter((trial) => trial.success);
  const verificationTrials = allTrials.filter((trial) => trial.changedPaths.length > 0);
  const verifiedTrials = verificationTrials.filter((trial) => hasTraceEvent(trial.trace, "completion_verification_satisfied"));
  const scopeFailures = allTrials.filter((trial) => trial.failureClassification === "workspace_scope");
  const toolFailures = allTrials.filter((trial) => hasTraceEvent(trial.trace, "tool_execution_failed") || trial.failureClassification === "tool_failure");
  const verificationCompletionRate = verificationTrials.length === 0 ? 1 : verifiedTrials.length / verificationTrials.length;
  const workspaceScopeViolationRate = allTrials.length === 0 ? 0 : scopeFailures.length / allTrials.length;
  gateReasons = [...gateReasons, ...collectReliabilityGateReasons(options.gateThresholds, verificationCompletionRate, workspaceScopeViolationRate)];

  return {
    gate: { passed: valid && gateReasons.length === 0, reasons: gateReasons },
    manifest: {
      codeSha: readCodeSha(configCwd),
      datasetSha256: hashFile(options.suitePath),
      generatedAt: new Date().toISOString(),
      modelName: providerConfig.model,
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
      promptVersion: suite.promptVersion,
      providerName: options.providerName,
      repetitions,
      suiteId: suite.id,
      suiteVersion: suite.version,
      toolSchemaVersion: suite.toolSchemaVersion
    },
    metrics: {
      averageRounds: mean(allTrials.map((trial) => trial.rounds)),
      costUsd: {
        available: totalCost !== null,
        average: totalCost === null ? null : totalCost / costValues.length,
        total: totalCost
      },
      averageToolCalls: mean(allTrials.map((trial) => trial.toolCallCount)),
      durationMs: {
        p50: percentile(allTrials.map((trial) => trial.durationMs), 0.5),
        p95: percentile(allTrials.map((trial) => trial.durationMs), 0.95)
      },
      passAtK: mean(taskResults.map((task) => task.passAtK)),
      passPowerK: mean(taskResults.map((task) => task.passPowerK)),
      standardError: standardError(successValues),
      successRate: allTrials.length === 0 ? 0 : successes / allTrials.length,
      successRate95: wilsonInterval(successes, allTrials.length),
      tokenUsage: { ...totalTokens, available: totalTokens.totalTokens > 0 },
      failureClassificationCounts,
      providerRecovery: { attempted: recoveryAttempts.length, recovered: recoveredTrials.length, successRate: recoveryAttempts.length === 0 ? 0 : recoveredTrials.length / recoveryAttempts.length },
      recoverySuccessRate: recoveryAttempts.length === 0 ? null : recoveredTrials.length / recoveryAttempts.length,
      toolFailureRate: allTrials.length === 0 ? 0 : toolFailures.length / allTrials.length,
      verificationCompletionRate,
      workspaceScopeViolationRate,
      invalidTrialCount: providerConfigurationFailures.length,
      providerConfigurationFailureCount: providerConfigurationFailures.length,
      valid
    },
    suite: { description: suite.description, id: suite.id, version: suite.version },
    tasks: taskResults
  };
}

async function runTrial(
  task: EvalTask,
  trial: number,
  providerConfig: ReturnType<typeof resolveProviderConfigForProvider>,
  options: CapabilityEvalOptions
): Promise<EvalTrialResult> {
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-eval-"));
  await seedWorkspace(workspaceRoot, {
    ...task.workspace.files,
    ...(options.workspaceOverlay ?? {})
  });
  const beforeFiles = await snapshotWorkspace(workspaceRoot);
  const handle = createApplication(workspaceRoot, {
    config: { databasePath: ":memory:", provider: providerConfig, workspaceRoot },
    ...(options.providerFactory !== undefined ? { provider: options.providerFactory() } : {}),
    scheduler: { autoStart: false }
  });
  const startedAt = Date.now();
  try {
    const runOptions = createDefaultRunOptions(task.input, workspaceRoot, handle.config);
    runOptions.agentProfileId = task.profile;
    runOptions.timeoutMs = task.timeoutMs;
    runOptions.userId = "eval-runner";
    let run = await handle.service.runTask(runOptions);
    while (run.task.status === "waiting_approval") {
      const approval = handle.service.listPendingApprovals()[0];
      if (approval === undefined) break;
      run = await handle.service.resolveApproval(approval.approvalId, task.approvalMode, "eval-runner");
    }
    const details = handle.service.showTask(run.task.taskId);
    const afterFiles = await snapshotWorkspace(workspaceRoot);
    const scorerResults = [];
    for (const scorer of task.scorers) {
      scorerResults.push(await evaluateScorer(scorer, {
        afterFiles,
        beforeFiles,
        ...(options.judge !== undefined ? { judge: options.judge } : {}),
        output: run.output,
        toolCalls: details.toolCalls,
        trace: details.trace,
        workspaceRoot
      }));
    }
    const statusPassed = run.task.status === "succeeded";
    const results = [{
      evidence: `task status=${run.task.status}`,
      id: "runtime_status",
      passed: statusPassed,
      required: true,
      score: statusPassed ? 1 : 0,
      type: "runtime_status"
    }, ...scorerResults];
    const trialCost = details.task?.tokenBudget.usedCostUsd;
    return {
      durationMs: Date.now() - startedAt,
      failureClassification: classifyFailure(run.task.status, results, details.trace),
      changedPaths: changedPaths(beforeFiles, afterFiles),
      costUsd: trialCost !== undefined && trialCost > 0 ? trialCost : null,
      output: run.output,
      rounds: details.task?.currentIteration ?? run.task.currentIteration,
      scorerResults: results,
      success: results.filter((score) => score.required).every((score) => score.passed),
      taskId: run.task.taskId,
      tokenUsage: computeTokenUsage(details.trace),
      toolCallCount: details.toolCalls.length,
      traceEventCount: details.trace.length,
      trace: details.trace,
      trial
    };
  } finally {
    handle.close();
    await fs.rm(workspaceRoot, { force: true, recursive: true });
  }
}

export function classifyFailure(status: string, results: EvalTrialResult["scorerResults"], trace: TraceEvent[]): EvalFailureClassification | null {
  if (results.filter((result) => result.required).every((result) => result.passed)) return null;
  if (trace.some((event) => event.eventType === "provider_request_failed" && /auth|credential|api key/iu.test(String(event.payload.errorMessage ?? "")))) return "provider_configuration_failure";
  // Hidden command graders are deterministic and take priority over runtime noise.
  if (results.some((result) => result.required && !result.passed && result.type === "workspace_diff" && /outside=\[(?!\])/u.test(result.evidence))) return "workspace_scope";
  if (results.some((result) => result.required && !result.passed && result.type === "command")) return "verification_failure";
  // A required workspace_diff that failed without an out-of-scope path (missing
  // required changes or no changes at all) is a verification/hygiene miss, not an
  // unclassified failure.
  if (results.some((result) => result.required && !result.passed && result.type === "workspace_diff")) return "verification_failure";
  if (trace.some((event) => event.eventType === "provider_request_failed" && event.payload.errorCategory === "timeout_error")) return "provider_timeout";
  if (hasTraceEvent(trace, "tool_execution_failed")) return "tool_failure";
  if (hasTraceEvent(trace, "environment_command_failed")) return "environment_failure";
  if (status === "failed" && (hasTraceEvent(trace, "iteration_exhausted") || hasTraceEvent(trace, "completion_verification_missing"))) return "control_flow_failure";
  if (results.some((result) => result.required && !result.passed && ["output", "file_state", "tool_trace", "trace"].includes(result.type))) return "model_or_contract";
  return "unknown";
}

function countFailureClassifications(trials: EvalTrialResult[]): Partial<Record<EvalFailureClassification, number>> {
  return trials.reduce<Partial<Record<EvalFailureClassification, number>>>((counts, trial) => {
    if (trial.failureClassification !== null && trial.failureClassification !== undefined) {
      const classification = trial.failureClassification;
      counts[classification] = (counts[classification] ?? 0) + 1;
    }
    return counts;
  }, {});
}

function hasTraceEvent(trace: TraceEvent[], eventType: string): boolean {
  return trace.some((event) => event.eventType === eventType);
}
function selectTasks(suite: EvalSuiteManifest, taskIds: string[] | undefined): EvalTask[] {
  if (taskIds === undefined || taskIds.length === 0) return suite.tasks;
  const byId = new Map(suite.tasks.map((task) => [task.id, task]));
  const missing = taskIds.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new Error(`Unknown eval task ids: ${missing.join(", ")}`);
  return taskIds.map((id) => byId.get(id) as EvalTask);
}

async function seedWorkspace(workspaceRoot: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = resolve(workspaceRoot, path);
    const relativePath = relative(workspaceRoot, target);
    if (relativePath.startsWith("..") || relativePath.includes(":")) throw new Error(`Eval fixture path escapes workspace: ${path}`);
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
}

async function snapshotWorkspace(workspaceRoot: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  async function walk(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if ([".auto-talon", ".git", "node_modules"].includes(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) snapshot.set(relative(workspaceRoot, absolute).replaceAll("\\", "/"), await fs.readFile(absolute, "utf8"));
    }
  }
  await walk(workspaceRoot);
  return snapshot;
}

function collectReliabilityGateReasons(
  thresholds: EvalGateThresholds | undefined,
  verificationCompletionRate: number,
  workspaceScopeViolationRate: number
): string[] {
  if (thresholds === undefined) {
    return [];
  }
  const reasons: string[] = [];
  if (
    thresholds.minVerificationCompletionRate !== undefined &&
    verificationCompletionRate < thresholds.minVerificationCompletionRate
  ) {
    reasons.push(
      `verification_completion_rate ${(verificationCompletionRate * 100).toFixed(1)}% below minimum ${(thresholds.minVerificationCompletionRate * 100).toFixed(1)}%`
    );
  }
  if (
    thresholds.maxWorkspaceScopeViolationRate !== undefined &&
    workspaceScopeViolationRate > thresholds.maxWorkspaceScopeViolationRate
  ) {
    reasons.push(
      `workspace_scope_violation_rate ${(workspaceScopeViolationRate * 100).toFixed(1)}% above maximum ${(thresholds.maxWorkspaceScopeViolationRate * 100).toFixed(1)}%`
    );
  }
  return reasons;
}

function collectGateReasons(tasks: EvalTaskResult[]): string[] {
  return tasks.flatMap((task) => {
    const isSafetyGate = task.task.risk === "high"
      || task.task.capabilities.some((capability) => ["policy", "safety"].includes(capability));
    if (!isSafetyGate) return [];
    return task.trials.flatMap((trial) => trial.scorerResults
      .filter((scorer) => scorer.required && !scorer.passed)
      .map((scorer) => `${task.task.id}#${trial.trial}:${scorer.id}`));
  });
}

function computeTokenUsage(trace: TraceEvent[]): EvalTrialResult["tokenUsage"] {
  return trace.reduce((total, event) => {
    if (event.eventType !== "provider_request_succeeded") return total;
    const usage = event.payload.usage;
    const inputTokens = typeof usage?.inputTokens === "number" ? usage.inputTokens : 0;
    const outputTokens = typeof usage?.outputTokens === "number" ? usage.outputTokens : 0;
    const cachedInputTokens = typeof usage?.cachedInputTokens === "number" ? usage.cachedInputTokens : 0;
    return {
      cachedInputTokens: total.cachedInputTokens + cachedInputTokens,
      inputTokens: total.inputTokens + inputTokens,
      outputTokens: total.outputTokens + outputTokens,
      totalTokens: total.totalTokens + (typeof usage?.totalTokens === "number" ? usage.totalTokens : inputTokens + outputTokens)
    };
  }, { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
}

function sumTokens(trials: EvalTrialResult[]): EvalTrialResult["tokenUsage"] {
  return trials.reduce((total, trial) => ({
    cachedInputTokens: total.cachedInputTokens + trial.tokenUsage.cachedInputTokens,
    inputTokens: total.inputTokens + trial.tokenUsage.inputTokens,
    outputTokens: total.outputTokens + trial.tokenUsage.outputTokens,
    totalTokens: total.totalTokens + trial.tokenUsage.totalTokens
  }), { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(resolve(path))).digest("hex");
}

function readCodeSha(cwd: string): string | null {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", windowsHide: true }).trim(); }
  catch { return null; }
}
