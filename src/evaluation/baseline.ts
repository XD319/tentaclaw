import type { EvalRunReport } from "./types.js";
import { difficultyCalibrationWarnings, taskFlipList } from "./grouped.js";
import { wilsonIntervalsOverlap } from "./statistics.js";

export interface EvalBaselineComparison {
  failed: boolean;
  failures: string[];
  warnings: string[];
  deltas: {
    passPowerK: number;
    successRate: number;
    costAverageRatio: number | null;
    durationP95Ratio: number | null;
  };
  flips: { id: string; from: number; to: number }[];
}

export interface EvalBaselineThresholds {
  allowDrift?: boolean;
  maxDurationP95IncreaseRatio?: number;
  maxPassPowerKDrop?: number;
  maxCostIncreaseRatio?: number;
}

const DRIFT_FIELDS = [
  "suiteVersion",
  "datasetSha256",
  "repetitions",
  "promptVersion",
  "toolSchemaVersion",
  "passAtKSize"
] as const;

export function compareEvalReports(
  current: EvalRunReport,
  baseline: EvalRunReport,
  thresholds: EvalBaselineThresholds = {}
): EvalBaselineComparison {
  if (current.manifest.suiteId !== baseline.manifest.suiteId) {
    throw new Error(`Cannot compare different eval suites: ${current.manifest.suiteId} vs ${baseline.manifest.suiteId}.`);
  }
  const driftWarnings = collectDriftWarnings(current, baseline);
  if (driftWarnings.length > 0 && thresholds.allowDrift !== true) {
    throw new Error(`Eval reports are not comparable: ${driftWarnings.join("; ")}. Pass allowDrift to compare anyway.`);
  }
  const maxPassPowerKDrop = thresholds.maxPassPowerKDrop ?? 0.1;
  const maxDurationP95IncreaseRatio = thresholds.maxDurationP95IncreaseRatio ?? 0.25;
  const successRateDelta = current.metrics.successRate - baseline.metrics.successRate;
  const maxCostIncreaseRatio = thresholds.maxCostIncreaseRatio ?? 0.25;
  const passPowerKDelta = current.metrics.passPowerK - baseline.metrics.passPowerK;
  const durationP95Ratio = baseline.metrics.durationMs.p95 > 0
    ? current.metrics.durationMs.p95 / baseline.metrics.durationMs.p95 - 1
    : null;
  const failures: string[] = [];
  const baselineAverageCost = baseline.metrics.costUsd?.average ?? null;
  const currentAverageCost = current.metrics.costUsd?.average ?? null;
  const costAverageRatio = baselineAverageCost !== null && baselineAverageCost > 0 && currentAverageCost !== null
    ? currentAverageCost / baselineAverageCost - 1
    : null;
  const warnings = [...driftWarnings, ...difficultyCalibrationWarnings(current.tasks)];

  if (!current.gate.passed) failures.push(...current.gate.reasons.map((reason) => `required scorer failed: ${reason}`));
  const currentWorse = current.metrics.successRate < baseline.metrics.successRate;
  if (
    currentWorse
    && !wilsonIntervalsOverlap(current.metrics.successRate95, baseline.metrics.successRate95)
  ) {
    failures.push(
      `success rate dropped ${(Math.abs(successRateDelta) * 100).toFixed(1)}pp with non-overlapping 95% Wilson intervals`
    );
  }
  if (passPowerKDelta < -maxPassPowerKDrop) failures.push(`pass^k dropped ${(Math.abs(passPowerKDelta) * 100).toFixed(1)}pp`);
  if (durationP95Ratio !== null && durationP95Ratio > maxDurationP95IncreaseRatio) {
    warnings.push(`p95 duration increased ${(durationP95Ratio * 100).toFixed(1)}%`);
  }
  if (costAverageRatio !== null && costAverageRatio > maxCostIncreaseRatio) {
    warnings.push(`average cost increased ${(costAverageRatio * 100).toFixed(1)}%`);
  }
  const baselineTaskIds = new Set(baseline.tasks.map((task) => task.task.id));
  for (const task of current.tasks.filter((item) => !baselineTaskIds.has(item.task.id))) {
    if (task.successRate < 1) failures.push(`new task is not fully passing: ${task.task.id}`);
  }
  const flips = taskFlipList(current.tasks, baseline.tasks);
  for (const flip of flips) {
    warnings.push(`task regression ${flip.id}: ${(flip.from * 100).toFixed(0)}% → ${(flip.to * 100).toFixed(0)}%`);
  }
  return {
    deltas: { costAverageRatio, durationP95Ratio, passPowerK: passPowerKDelta, successRate: successRateDelta },
    failed: failures.length > 0,
    failures,
    flips,
    warnings
  };
}

function collectDriftWarnings(current: EvalRunReport, baseline: EvalRunReport): string[] {
  const warnings: string[] = [];
  for (const field of DRIFT_FIELDS) {
    const currentValue = field === "passAtKSize"
      ? current.manifest.passAtKSize ?? current.manifest.repetitions
      : current.manifest[field];
    const baselineValue = field === "passAtKSize"
      ? baseline.manifest.passAtKSize ?? baseline.manifest.repetitions
      : baseline.manifest[field];
    if (currentValue !== baselineValue) {
      warnings.push(`${field} drifted (${String(baselineValue)} → ${String(currentValue)})`);
    }
  }
  if (current.manifest.sampling !== undefined && baseline.manifest.sampling !== undefined) {
    if (JSON.stringify(current.manifest.sampling) !== JSON.stringify(baseline.manifest.sampling)) {
      warnings.push("provider sampling parameters drifted");
    }
  }
  return warnings;
}
