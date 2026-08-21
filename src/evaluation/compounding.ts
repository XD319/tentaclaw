import { promises as fs } from "node:fs";
import { join, relative, resolve } from "node:path";

import { runCapabilityEval, type CapabilityEvalOptions } from "./runner.js";
import type { EvalRunReport } from "./types.js";

export const DEFAULT_COMPOUNDING_SUITE = "fixtures/eval-suites/compounding-self-evolution.v1.json";
export const DEFAULT_COMPOUNDING_ACCUMULATED_ROOT = "fixtures/eval-compounding/accumulated";

export interface CompoundingEvalThresholds {
  maxPassPowerKDrop?: number;
  maxSuccessRateDrop?: number;
}

export interface CompoundingEvalOptions extends CapabilityEvalOptions {
  accumulatedRoot?: string;
  compoundingThresholds?: CompoundingEvalThresholds;
}

export interface CompoundingEvalReport {
  accumulated: EvalRunReport;
  deltas: {
    averageRounds: number;
    passPowerK: number;
    successRate: number;
    tokensPerSuccess: number | null;
  };
  empty: EvalRunReport;
  gate: {
    passed: boolean;
    reasons: string[];
  };
}

export async function runCompoundingEval(options: CompoundingEvalOptions): Promise<CompoundingEvalReport> {
  const accumulatedRoot = resolve(options.accumulatedRoot ?? DEFAULT_COMPOUNDING_ACCUMULATED_ROOT);
  const overlay = await loadWorkspaceOverlay(accumulatedRoot);
  const evalOptions: CapabilityEvalOptions = {
    providerName: options.providerName,
    suitePath: options.suitePath,
    ...(options.configCwd !== undefined ? { configCwd: options.configCwd } : {}),
    ...(options.gateThresholds !== undefined ? { gateThresholds: options.gateThresholds } : {}),
    ...(options.judge !== undefined ? { judge: options.judge } : {}),
    ...(options.providerFactory !== undefined ? { providerFactory: options.providerFactory } : {}),
    ...(options.repetitions !== undefined ? { repetitions: options.repetitions } : {}),
    ...(options.taskIds !== undefined ? { taskIds: options.taskIds } : {})
  };
  const empty = await runCapabilityEval(evalOptions);
  const accumulated = await runCapabilityEval({
    ...evalOptions,
    workspaceOverlay: overlay
  });
  return compareCompoundingReports(empty, accumulated, options.compoundingThresholds);
}

export function compareCompoundingReports(
  empty: EvalRunReport,
  accumulated: EvalRunReport,
  thresholds: CompoundingEvalThresholds = {}
): CompoundingEvalReport {
  const maxSuccessRateDrop = thresholds.maxSuccessRateDrop ?? 0.05;
  const maxPassPowerKDrop = thresholds.maxPassPowerKDrop ?? 0.1;
  const emptyTokensPerSuccess = tokensPerSuccess(empty);
  const accumulatedTokensPerSuccess = tokensPerSuccess(accumulated);
  const successRateDelta = accumulated.metrics.successRate - empty.metrics.successRate;
  const passPowerKDelta = accumulated.metrics.passPowerK - empty.metrics.passPowerK;
  const reasons: string[] = [];

  if (!empty.gate.passed) {
    reasons.push(...empty.gate.reasons.map((reason) => `empty: ${reason}`));
  }
  if (!accumulated.gate.passed) {
    reasons.push(...accumulated.gate.reasons.map((reason) => `accumulated: ${reason}`));
  }
  if (successRateDelta < -maxSuccessRateDrop) {
    reasons.push(
      `self-evolution success rate dropped ${(Math.abs(successRateDelta) * 100).toFixed(1)}pp`
    );
  }
  if (passPowerKDelta < -maxPassPowerKDrop) {
    reasons.push(
      `self-evolution pass^k dropped ${(Math.abs(passPowerKDelta) * 100).toFixed(1)}pp`
    );
  }

  return {
    accumulated,
    deltas: {
      averageRounds: accumulated.metrics.averageRounds - empty.metrics.averageRounds,
      passPowerK: passPowerKDelta,
      successRate: successRateDelta,
      tokensPerSuccess:
        emptyTokensPerSuccess === null || accumulatedTokensPerSuccess === null
          ? null
          : accumulatedTokensPerSuccess - emptyTokensPerSuccess
    },
    empty,
    gate: {
      passed: reasons.length === 0,
      reasons
    }
  };
}

export async function loadWorkspaceOverlay(root: string): Promise<Record<string, string>> {
  const absoluteRoot = resolve(root);
  const overlay: Record<string, string> = {};
  await walkOverlay(absoluteRoot, absoluteRoot, overlay);
  if (Object.keys(overlay).length === 0) {
    throw new Error(`Compounding accumulated overlay is empty: ${absoluteRoot}`);
  }
  return overlay;
}

export function tokensPerSuccess(report: EvalRunReport): number | null {
  const successes = report.tasks.flatMap((task) => task.trials).filter((trial) => trial.success).length;
  if (successes === 0) {
    return null;
  }
  return report.metrics.tokenUsage.totalTokens / successes;
}

async function walkOverlay(
  root: string,
  directory: string,
  overlay: Record<string, string>
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `Compounding accumulated overlay was not found: ${root}`,
      error instanceof Error ? { cause: error } : undefined
    );
  }
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkOverlay(root, absolute, overlay);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const relativePath = toWorkspaceOverlayPath(relative(root, absolute).replaceAll("\\", "/"));
    overlay[relativePath] = await fs.readFile(absolute, "utf8");
  }
}

function toWorkspaceOverlayPath(relativePath: string): string {
  if (relativePath === "skills" || relativePath.startsWith("skills/")) {
    return `.auto-talon/${relativePath}`;
  }
  return relativePath;
}
