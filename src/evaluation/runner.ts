import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { resolveProviderConfigForProvider } from "../providers/index.js";
import { RecallEngine } from "../recall/recall-engine.js";
import { createApplication, createDefaultRunOptions, type AppConfig, type AppRuntimeHandle } from "../runtime/index.js";
import type { Provider, TraceEvent } from "../types/index.js";
import { collectGroupedMetrics } from "./grouped.js";
import { materializeMemoryState, prepareMemoryEvalWorkspace } from "./memory-state.js";
import { computePairedMetrics } from "./paired.js";
import { changedPaths, evaluateScorer } from "./scorers.js";
import { loadEvalSuite, type EvalMemoryState, type EvalSuiteManifest, type EvalTask } from "./schema.js";
import { mean, passAtK, passPowerK, percentile, standardError, wilsonInterval } from "./statistics.js";
import type {
  EvalFailureClassification,
  EvalMemoryArm,
  EvalRunReport,
  EvalSamplingManifest,
  EvalTaskResult,
  EvalTrialResult
} from "./types.js";
import { copyWorkspaceForGrading, listHygieneWrites, seedWorkspace, snapshotWorkspace } from "./workspace.js";

export interface EvalGateThresholds {
  maxHarnessErrorRate?: number;
  maxWorkspaceScopeViolationRate?: number;
  minVerificationCompletionRate?: number;
}

export interface CapabilityEvalOptions {
  arm?: EvalMemoryArm;
  /**
   * Optional per-trial override for macro-compaction thresholds.
   * Merged into `createApplication({ config: { compact } })` so A/B harnesses
   * can force compaction on/off without touching `runtime.config.json`.
   */
  compactOverride?: Partial<AppConfig["compact"]>;
  concurrency?: number;
  /**
   * Optional per-trial partial AppConfig override (contextRetention, tokenBudget, compact, …).
   * `compactOverride` is merged on top when both are set.
   */
  configOverride?: Partial<AppConfig>;
  configCwd?: string;
  gateThresholds?: EvalGateThresholds;
  judge?: Parameters<typeof evaluateScorer>[1]["judge"];
  maxCostUsd?: number;
  passAtK?: number;
  providerFactory?: () => Provider;
  providerName: string;
  repetitions?: number;
  resumeDirectory?: string;
  suitePath: string;
  taskIds?: string[];
  /** Extra workspace files seeded for every trial (not part of the task fixture). */
  workspaceOverlay?: Record<string, string>;
}

interface WorkItem {
  arm?: EvalMemoryArm;
  memoryState?: EvalMemoryState;
  task: EvalTask;
  trial: number;
}

export async function runCapabilityEval(options: CapabilityEvalOptions): Promise<EvalRunReport> {
  const repetitions = options.repetitions ?? 3;
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20) {
    throw new Error("Eval repetitions must be an integer between 1 and 20.");
  }
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error("Eval concurrency must be an integer between 1 and 32.");
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
  const passAtKSize = options.passAtK ?? repetitions;
  const completed = await loadCompletedTrials(options.resumeDirectory);
  const workItems = expandWorkItems(suite, tasks, repetitions, options.arm);
  const pending = workItems.filter((item) => !completed.has(workKey(item)));
  const trialResults: EvalTrialResult[] = [...completed.values()];
  let spent = trialResults.reduce((total, trial) => total + (trial.costUsd ?? 0), 0);
  let exhausted = options.maxCostUsd !== undefined && spent > options.maxCostUsd;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, pending.length)) }, async () => {
    while (cursor < pending.length) {
      const index = cursor;
      cursor += 1;
      const item = pending[index];
      if (item === undefined) {
        return;
      }
      if (exhausted) {
        return;
      }
      const trial = await runTrial(item, providerConfig, options);
      trialResults.push(trial);
      if (options.resumeDirectory !== undefined) {
        await appendTrial(options.resumeDirectory, item, trial);
      }
      spent += trial.costUsd ?? 0;
      if (options.maxCostUsd !== undefined && spent > options.maxCostUsd) {
        exhausted = true;
      }
    }
  });
  await Promise.all(workers);

  const taskResults = assembleTaskResults(workItems, trialResults, repetitions, passAtKSize);
  const allTrials = taskResults.flatMap((task) => task.trials);
  const harnessTrials = allTrials.filter((trial) => trial.failureClassification === "harness_error");
  const scorable = allTrials.filter((trial) => trial.failureClassification !== "harness_error");
  const costValues = allTrials.flatMap((trial) => trial.costUsd === null ? [] : [trial.costUsd]);
  const totalCost = costValues.length === 0 ? null : costValues.reduce((total, value) => total + value, 0);
  const successes = scorable.filter((trial) => trial.success).length;
  const successValues = scorable.map((trial) => trial.success ? 1 : 0);
  let gateReasons = collectGateReasons(taskResults);
  const totalTokens = sumTokens(allTrials);
  const failureClassificationCounts = countFailureClassifications(allTrials);
  const providerConfigurationFailures = allTrials.filter((trial) => trial.failureClassification === "provider_configuration_failure");
  const harnessErrorRate = allTrials.length === 0 ? 0 : harnessTrials.length / allTrials.length;
  const maxHarnessErrorRate = options.gateThresholds?.maxHarnessErrorRate ?? 0.05;
  let valid = providerConfigurationFailures.length === 0 && harnessErrorRate <= maxHarnessErrorRate;
  if (providerConfigurationFailures.length > 0) {
    gateReasons = [`invalid_run: provider configuration failed in ${providerConfigurationFailures.length} trial(s)`, ...gateReasons];
  }
  if (harnessErrorRate > maxHarnessErrorRate) {
    valid = false;
    gateReasons = [`invalid_run: harness_error rate ${(harnessErrorRate * 100).toFixed(1)}% exceeds ${(maxHarnessErrorRate * 100).toFixed(1)}%`, ...gateReasons];
  }
  if (exhausted) {
    valid = false;
    gateReasons = [`invalid_run: max cost $${options.maxCostUsd} exceeded`, ...gateReasons];
  }
  const recoveryAttempts = scorable.filter((trial) => hasTraceEvent(trial.trace, "task_recovery_started"));
  const recoveredTrials = recoveryAttempts.filter((trial) => trial.success);
  const verificationTrials = scorable.filter((trial) => trial.changedPaths.length > 0);
  const verifiedTrials = verificationTrials.filter((trial) => hasTraceEvent(trial.trace, "completion_verification_satisfied"));
  const scopeFailures = scorable.filter((trial) => trial.failureClassification === "workspace_scope");
  const toolFailures = scorable.filter((trial) => hasTraceEvent(trial.trace, "tool_execution_failed") || trial.failureClassification === "tool_failure");
  const unrecoveredToolFailures = toolFailures.filter((trial) => !trial.success);
  const verificationCompletionRate = verificationTrials.length === 0 ? null : verifiedTrials.length / verificationTrials.length;
  const workspaceScopeViolationRate = scorable.length === 0 ? 0 : scopeFailures.length / scorable.length;
  gateReasons = [...gateReasons, ...collectReliabilityGateReasons(options.gateThresholds, verificationCompletionRate, workspaceScopeViolationRate)];
  const paired = computePairedMetrics(taskResults, suite.memoryEval?.expectedRecallTitles ?? [], suite.memoryEval?.poisonMarkers ?? []);
  const sampling: EvalSamplingManifest = {
    contextWindowTokens: providerConfig.contextWindowTokens,
    maxRetries: providerConfig.maxRetries,
    modelName: providerConfig.model,
    streamIdleTimeoutMs: providerConfig.streamIdleTimeoutMs,
    timeoutMs: providerConfig.timeoutMs
  };

  return {
    gate: { passed: valid && gateReasons.length === 0, reasons: gateReasons },
    manifest: {
      codeSha: readCodeSha(configCwd),
      datasetSha256: hashFile(options.suitePath),
      generatedAt: new Date().toISOString(),
      modelName: providerConfig.model,
      nodeVersion: process.version,
      passAtKSize,
      platform: `${process.platform}-${process.arch}`,
      promptVersion: suite.promptVersion,
      providerName: options.providerName,
      repetitions,
      sampling,
      suiteId: suite.id,
      suiteVersion: suite.version,
      toolSchemaVersion: suite.toolSchemaVersion
    },
    metrics: {
      averageRounds: mean(scorable.map((trial) => trial.rounds)),
      costUsd: {
        available: totalCost !== null,
        average: allTrials.length === 0 || totalCost === null ? null : totalCost / allTrials.length,
        coverage: allTrials.length === 0 ? 0 : costValues.length / allTrials.length,
        total: totalCost
      },
      averageToolCalls: mean(scorable.map((trial) => trial.toolCallCount)),
      durationMs: {
        p50: percentile(scorable.map((trial) => trial.durationMs), 0.5),
        p95: percentile(scorable.map((trial) => trial.durationMs), 0.95)
      },
      grouped: collectGroupedMetrics(taskResults),
      harnessErrorRate,
      passAtK: mean(taskResults.map((task) => task.passAtK)),
      passPowerK: mean(taskResults.map((task) => task.passPowerK)),
      ...(paired !== undefined ? { paired, poisonFollowingRate: paired.poisonFollowingRate, recallAtK: paired.recallAtK } : {}),
      standardError: standardError(successValues),
      scorableTrialCount: scorable.length,
      successRate: scorable.length === 0 ? 0 : successes / scorable.length,
      successRate95: wilsonInterval(successes, scorable.length),
      tokenUsage: { ...totalTokens, available: totalTokens.totalTokens > 0 },
      failureClassificationCounts,
      providerRecovery: { attempted: recoveryAttempts.length, recovered: recoveredTrials.length, successRate: recoveryAttempts.length === 0 ? 0 : recoveredTrials.length / recoveryAttempts.length },
      recoverySuccessRate: recoveryAttempts.length === 0 ? null : recoveredTrials.length / recoveryAttempts.length,
      toolFailureOccurrenceRate: scorable.length === 0 ? 0 : toolFailures.length / scorable.length,
      toolFailureRate: scorable.length === 0 ? 0 : unrecoveredToolFailures.length / scorable.length,
      toolFailureUnrecoveredRate: scorable.length === 0 ? 0 : unrecoveredToolFailures.length / scorable.length,
      verificationCompletionRate,
      workspaceScopeViolationRate,
      invalidTrialCount: providerConfigurationFailures.length + harnessTrials.length,
      providerConfigurationFailureCount: providerConfigurationFailures.length,
      valid
    },
    suite: { description: suite.description, id: suite.id, version: suite.version },
    tasks: taskResults
  };
}

async function runTrial(
  item: WorkItem,
  providerConfig: ReturnType<typeof resolveProviderConfigForProvider>,
  options: CapabilityEvalOptions
): Promise<EvalTrialResult> {
  const { task, trial } = item;
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-eval-"));
  const gradingRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-eval-grade-"));
  await seedWorkspace(workspaceRoot, {
    ...task.workspace.files,
    ...(options.workspaceOverlay ?? {})
  });
  if (item.memoryState !== undefined) {
    await prepareMemoryEvalWorkspace(workspaceRoot, item.memoryState);
  }
  const beforeFiles = await snapshotWorkspace(workspaceRoot);
  const applicationConfig: Partial<AppConfig> = {
    databasePath: ":memory:",
    provider: providerConfig,
    workspaceRoot
  };
  if (options.configOverride !== undefined) {
    if (options.configOverride.compact !== undefined) {
      applicationConfig.compact = options.configOverride.compact;
    }
    if (options.configOverride.contextRetention !== undefined) {
      applicationConfig.contextRetention = options.configOverride.contextRetention;
    }
    if (options.configOverride.tokenBudget !== undefined) {
      applicationConfig.tokenBudget = options.configOverride.tokenBudget;
    }
    if (options.configOverride.tokenBudgetInputLimitExplicit !== undefined) {
      applicationConfig.tokenBudgetInputLimitExplicit =
        options.configOverride.tokenBudgetInputLimitExplicit;
    }
  }
  if (options.compactOverride !== undefined) {
    // mergeCreateApplicationConfig deep-merges compact; partial overrides are intentional.
    applicationConfig.compact = {
      ...(applicationConfig.compact ?? {}),
      ...options.compactOverride
    } as AppConfig["compact"];
  }
  let handle: AppRuntimeHandle | undefined;
  const startedAt = Date.now();
  try {
    handle = createApplication(workspaceRoot, {
      config: applicationConfig,
      ...(options.providerFactory !== undefined ? { provider: options.providerFactory() } : {}),
      scheduler: { autoStart: false }
    });
    if (item.memoryState !== undefined) {
      materializeMemoryState(handle, item.memoryState, workspaceRoot);
    }
    const recalledTitles = new RecallEngine()
      .rankMemory(
        handle.infrastructure.storage.memories.list({ includeExpired: false, scope: "project", scopeKey: workspaceRoot }),
        task.input,
        10
      )
      .map((candidate) => candidate.memory.title);
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
    const hygieneWrites = await listHygieneWrites(workspaceRoot);
    await copyWorkspaceForGrading(workspaceRoot, gradingRoot);
    const scorerResults = [];
    for (const scorer of task.scorers) {
      scorerResults.push(await evaluateScorer(scorer, {
        afterFiles,
        beforeFiles,
        ...(options.judge !== undefined ? { judge: options.judge } : {}),
        output: run.output,
        toolCalls: details.toolCalls,
        trace: details.trace,
        workspaceRoot: gradingRoot
      }));
    }
    const statusPassed = run.task.status === "succeeded";
    const results = [{
      evidence: `task status=${run.task.status}`,
      id: "runtime_status",
      passed: statusPassed,
      required: true,
      score: statusPassed ? 1 : 0,
      status: statusPassed ? "passed" as const : "failed" as const,
      type: "runtime_status"
    }, ...scorerResults];
    const harnessError = results.some((score) => score.status === "error");
    const trialCost = details.task?.tokenBudget.usedCostUsd;
    return {
      ...(item.arm !== undefined ? { arm: item.arm } : {}),
      durationMs: Date.now() - startedAt,
      failureClassification: harnessError ? "harness_error" : classifyFailure(run.task.status, results, details.trace),
      changedPaths: changedPaths(beforeFiles, afterFiles),
      costUsd: trialCost !== undefined && trialCost > 0 ? trialCost : null,
      fixtureTaskId: task.id,
      hygieneWrites,
      output: run.output,
      recalledTitles,
      rounds: details.task?.currentIteration ?? run.task.currentIteration,
      scorerResults: results,
      success: !harnessError && results.filter((score) => score.required && score.status !== "skipped").every((score) => score.passed),
      taskId: run.task.taskId,
      tokenUsage: computeTokenUsage(details.trace),
      toolCallCount: details.toolCalls.length,
      traceEventCount: details.trace.length,
      trace: details.trace,
      trial
    };
  } catch (error) {
    return {
      ...(item.arm !== undefined ? { arm: item.arm } : {}),
      changedPaths: [],
      costUsd: null,
      durationMs: Date.now() - startedAt,
      failureClassification: "harness_error",
      fixtureTaskId: task.id,
      hygieneWrites: [],
      output: null,
      recalledTitles: [],
      rounds: 0,
      scorerResults: [{
        evidence: error instanceof Error ? error.message : String(error),
        id: "harness",
        passed: false,
        required: true,
        score: 0,
        status: "error",
        type: "runtime_status"
      }],
      success: false,
      taskId: `harness-${task.id}-${trial}`,
      tokenUsage: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      toolCallCount: 0,
      trace: [],
      traceEventCount: 0,
      trial
    };
  } finally {
    handle?.close();
    await fs.rm(workspaceRoot, { force: true, recursive: true });
    await fs.rm(gradingRoot, { force: true, recursive: true });
  }
}

export function classifyFailure(status: string, results: EvalTrialResult["scorerResults"], trace: TraceEvent[]): EvalFailureClassification | null {
  if (results.some((result) => result.status === "error")) return "harness_error";
  if (results.filter((result) => result.required && result.status !== "skipped").every((result) => result.passed)) return null;
  if (trace.some((event) => event.eventType === "provider_request_failed" && /auth|credential|api key/iu.test(String(event.payload.errorMessage ?? "")))) return "provider_configuration_failure";
  if (results.some((result) => result.required && !result.passed && result.type === "workspace_diff" && /outside=\[(?!\])/u.test(result.evidence))) return "workspace_scope";
  if (results.some((result) => result.required && !result.passed && result.type === "command")) return "verification_failure";
  if (results.some((result) => result.required && !result.passed && result.type === "workspace_diff")) return "verification_failure";
  if (trace.some((event) => event.eventType === "provider_request_failed" && event.payload.errorCategory === "timeout_error")) return "provider_timeout";
  if (hasTraceEvent(trace, "tool_execution_failed")) return "tool_failure";
  if (
    status === "failed" &&
    (hasTraceEvent(trace, "iteration_exhausted") ||
      hasTraceEvent(trace, "invalid_final_output_rejected") ||
      hasTraceEvent(trace, "completion_verification_missing"))
  ) {
    return "control_flow_failure";
  }
  if (hasTraceEvent(trace, "environment_command_failed")) return "environment_failure";
  if (results.some((result) => result.required && !result.passed && ["output", "file_state", "tool_trace", "trace"].includes(result.type))) return "model_or_contract";
  return "unknown";
}

function expandWorkItems(
  suite: EvalSuiteManifest,
  tasks: EvalTask[],
  repetitions: number,
  armFilter?: EvalMemoryArm
): WorkItem[] {
  const arms: Array<{ arm?: EvalMemoryArm; memoryState?: EvalMemoryState }> = suite.memoryEval === undefined
    ? [{}]
    : (["cold", "warm", "distractor", "poisoned"] as EvalMemoryArm[])
      .filter((arm) => armFilter === undefined || arm === armFilter)
      .map((arm) => {
        const memoryState = suite.memoryEval?.arms[arm];
        return memoryState === undefined ? { arm } : { arm, memoryState };
      });
  return tasks.flatMap((task) =>
    arms.flatMap(({ arm, memoryState }) =>
      Array.from({ length: repetitions }, (_, index) => ({
        ...(arm !== undefined ? { arm } : {}),
        ...(memoryState !== undefined ? { memoryState } : {}),
        task,
        trial: index + 1
      }))
    )
  );
}

function assembleTaskResults(
  workItems: WorkItem[],
  trials: EvalTrialResult[],
  repetitions: number,
  passAtKSize: number
): EvalTaskResult[] {
  const remaining = [...trials];
  const take = (item: WorkItem): EvalTrialResult | undefined => {
    const index = remaining.findIndex((trial) =>
      trial.trial === item.trial && trial.arm === item.arm && trial.fixtureTaskId === item.task.id
    );
    if (index < 0) {
      return undefined;
    }
    return remaining.splice(index, 1)[0];
  };
  const groups = new Map<string, { item: WorkItem; trials: EvalTrialResult[] }>();
  for (const item of workItems) {
    const key = `${item.task.id}::${item.arm ?? "_"}`;
    const group = groups.get(key) ?? { item, trials: [] };
    const trial = take(item);
    if (trial !== undefined) {
      group.trials.push(trial);
    }
    groups.set(key, group);
  }
  return [...groups.values()].map(({ item, trials: groupTrials }) => {
    const ordered = [...groupTrials].sort((left, right) => left.trial - right.trial);
    const scorable = ordered.filter((trial) => trial.failureClassification !== "harness_error");
    const successes = scorable.filter((trial) => trial.success).length;
    const n = Math.max(scorable.length, repetitions);
    return {
      ...(item.arm !== undefined ? { arm: item.arm } : {}),
      passAtK: passAtK(successes, n, passAtKSize),
      passPowerK: passPowerK(successes, n, passAtKSize),
      successRate: scorable.length === 0 ? 0 : successes / scorable.length,
      task: {
        capabilities: item.task.capabilities,
        category: item.task.category,
        difficulty: item.task.difficulty,
        id: item.task.id,
        risk: item.task.risk,
        title: item.task.title
      },
      trials: ordered
    };
  });
}

function workKey(item: WorkItem): string {
  return `${item.task.id}::${item.trial}::${item.arm ?? "_"}`;
}

async function loadCompletedTrials(directory: string | undefined): Promise<Map<string, EvalTrialResult>> {
  const completed = new Map<string, EvalTrialResult>();
  if (directory === undefined) {
    return completed;
  }
  const path = join(resolve(directory), "eval-trials.jsonl");
  try {
    const text = await fs.readFile(path, "utf8");
    for (const line of text.split("\n").filter(Boolean)) {
      const parsed = JSON.parse(line) as { key: string; trial: EvalTrialResult };
      completed.set(parsed.key, parsed.trial);
    }
  } catch {
    return completed;
  }
  return completed;
}

async function appendTrial(directory: string, item: WorkItem, trial: EvalTrialResult): Promise<void> {
  const path = join(resolve(directory), "eval-trials.jsonl");
  await fs.mkdir(resolve(directory), { recursive: true });
  await fs.appendFile(path, `${JSON.stringify({ key: workKey(item), trial })}\n`, "utf8");
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

function collectReliabilityGateReasons(
  thresholds: EvalGateThresholds | undefined,
  verificationCompletionRate: number | null,
  workspaceScopeViolationRate: number
): string[] {
  if (thresholds === undefined) {
    return [];
  }
  const reasons: string[] = [];
  if (thresholds.minVerificationCompletionRate !== undefined) {
    if (verificationCompletionRate === null) {
      reasons.push("insufficient_evidence: verification_completion_rate");
    } else if (verificationCompletionRate < thresholds.minVerificationCompletionRate) {
      reasons.push(
        `verification_completion_rate ${(verificationCompletionRate * 100).toFixed(1)}% below minimum ${(thresholds.minVerificationCompletionRate * 100).toFixed(1)}%`
      );
    }
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
      .filter((scorer) => scorer.required && scorer.status !== "skipped" && !scorer.passed)
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
