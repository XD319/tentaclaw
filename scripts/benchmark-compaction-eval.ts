/**
 * Compaction ON/OFF A/B harness against the long-context blind eval suite.
 *
 * Runs the same suite/provider twice with compactOverride:
 *   ON  — low thresholds so macro-compaction fires (deterministic summarizer)
 *   OFF — extreme thresholds so macro-compaction never fires
 *
 * Compares successRate / passAtK / inputTokens / totalTokens and counts
 * session_compacted events in traces.
 *
 * Usage:
 *   node --import tsx scripts/benchmark-compaction-eval.ts --provider <name>
 * Optional:
 *   --suite <path>          default fixtures/eval-suites/long-context.v1.json
 *   --repetitions <n>       default 1
 *   --output <dir>          default eval-artifacts/compaction-ab
 *   --tasks <id,id,...>     optional subset
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { runCapabilityEval, type EvalRunReport } from "../src/evaluation/index.js";
import type { AppConfig } from "../src/runtime/index.js";

const DEFAULT_SUITE = "fixtures/eval-suites/long-context.v1.json";
const DEFAULT_OUTPUT = "eval-artifacts/compaction-ab";

const COMPACT_ON: Partial<AppConfig["compact"]> = {
  // Trigger often enough to fire, but keep a short protected tail so summarization
  // actually removes mid-window tool payloads instead of appending a handoff on top.
  iterationThreshold: 6,
  messageThreshold: 16,
  minTokenPressureRatio: 0,
  protectFirstN: 1,
  protectLastN: 4,
  summarizer: "deterministic",
  tailMinMessages: 2,
  targetRatio: 0.15,
  thresholdRatio: 0.45,
  toolCallThreshold: 8
};

/** Same thresholds as COMPACT_ON but with pressure gate (prefix stability is runtime code). */
const COMPACT_OPTIMIZED: Partial<AppConfig["compact"]> = {
  ...COMPACT_ON,
  minTokenPressureRatio: 0.5
};

const COMPACT_OFF: Partial<AppConfig["compact"]> = {
  tokenThreshold: 1_000_000_000,
  messageThreshold: 1_000_000_000,
  iterationThreshold: 1_000_000_000,
  toolCallThreshold: 1_000_000_000,
  summarizer: "deterministic"
};

interface CliOptions {
  arm: string | null;
  arms: "on-off" | "governed-optimized";
  help: boolean;
  output: string;
  provider: string | null;
  repetitions: number;
  suite: string;
  taskIds: string[];
}

function printHelp(): void {
  console.log(`Usage:
  node --import tsx scripts/benchmark-compaction-eval.ts --provider <name> [options]

Options:
  --provider <name>       Required. Configured real provider to evaluate
  --suite <path>          Eval suite path (default: ${DEFAULT_SUITE})
  --repetitions <n>       Trials per task (default: 1)
  --output <dir>          Output directory (default: ${DEFAULT_OUTPUT})
  --tasks <id,id,...>     Optional comma-separated task id subset
  --mode <on-off|governed-optimized>
                          on-off (default): compaction ON vs OFF
                          governed-optimized: aggressive compact vs pressure-gated + stable prefix
  --arm <name>            Run a single arm (on|off|governed|optimized)
  --help                  Show this help`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    arm: null,
    arms: "on-off",
    help: false,
    output: DEFAULT_OUTPUT,
    provider: null,
    repetitions: 1,
    suite: DEFAULT_SUITE,
    taskIds: []
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--mode":
        if (next === undefined) throw new Error("--mode requires a value");
        if (next !== "on-off" && next !== "governed-optimized") {
          throw new Error("--mode must be on-off or governed-optimized");
        }
        options.arms = next;
        i += 1;
        break;
      case "--arm":
        if (next === undefined) throw new Error("--arm requires a value");
        options.arm = next;
        i += 1;
        break;
      case "--provider":
        if (next === undefined) throw new Error("--provider requires a value");
        options.provider = next;
        i += 1;
        break;
      case "--suite":
        if (next === undefined) throw new Error("--suite requires a value");
        options.suite = next;
        i += 1;
        break;
      case "--repetitions":
        if (next === undefined) throw new Error("--repetitions requires a value");
        options.repetitions = Number.parseInt(next, 10);
        if (!Number.isInteger(options.repetitions) || options.repetitions < 1) {
          throw new Error("--repetitions must be a positive integer");
        }
        i += 1;
        break;
      case "--output":
        if (next === undefined) throw new Error("--output requires a value");
        options.output = next;
        i += 1;
        break;
      case "--tasks":
        if (next === undefined) throw new Error("--tasks requires a value");
        options.taskIds = next
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        i += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function countSessionCompacted(report: EvalRunReport): number {
  return report.tasks
    .flatMap((task) => task.trials)
    .flatMap((trial) => trial.trace)
    .filter((event) => event.eventType === "session_compacted").length;
}

function summarizeArm(label: string, report: EvalRunReport) {
  const trials = report.tasks.flatMap((task) => task.trials);
  const cachedInputTokens = trials.reduce(
    (sum, trial) => sum + (trial.tokenUsage.cachedInputTokens ?? 0),
    0
  );
  const inputTokens = report.metrics.tokenUsage.inputTokens;
  return {
    cachedInputTokens,
    cacheHitRate: inputTokens === 0 ? 0 : cachedInputTokens / inputTokens,
    gatePassed: report.gate.passed,
    inputTokens,
    label,
    passAtK: report.metrics.passAtK,
    sessionCompactedEvents: countSessionCompacted(report),
    successRate: report.metrics.successRate,
    tokenUsageAvailable: report.metrics.tokenUsage.available,
    totalTokens: report.metrics.tokenUsage.totalTokens
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.provider === null || options.provider.trim() === "") {
    printHelp();
    throw new Error("--provider is required");
  }

  const outputRoot = resolve(options.output);
  const common = {
    providerName: options.provider,
    repetitions: options.repetitions,
    suitePath: options.suite,
    ...(options.taskIds.length > 0 ? { taskIds: options.taskIds } : {})
  };

  const allArmDefs =
    options.arms === "governed-optimized"
      ? [
          { compactOverride: COMPACT_ON, dir: "governed", label: "governed" },
          { compactOverride: COMPACT_OPTIMIZED, dir: "optimized", label: "optimized" }
        ]
      : [
          { compactOverride: COMPACT_ON, dir: "on", label: "on" },
          { compactOverride: COMPACT_OFF, dir: "off", label: "off" }
        ];
  const armDefs =
    options.arm === null
      ? allArmDefs
      : allArmDefs.filter((arm) => arm.label === options.arm);
  if (armDefs.length === 0) {
    throw new Error(
      `Unknown --arm "${options.arm}". Expected one of: ${allArmDefs.map((arm) => arm.label).join(", ")}`
    );
  }

  const summaries: Record<string, ReturnType<typeof summarizeArm>> = {};
  for (const arm of armDefs) {
    const armDir = join(outputRoot, arm.dir);
    mkdirSync(armDir, { recursive: true });
    console.error(`Running ${arm.label} against ${options.suite}...`);
    const report = await runCapabilityEval({
      ...common,
      compactOverride: arm.compactOverride
    });
    writeFileSync(join(armDir, "eval-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    summaries[arm.label] = summarizeArm(arm.label, report);
  }

  const labels = Object.keys(summaries);
  const leftLabel = labels[0];
  if (leftLabel === undefined) {
    throw new Error("No eval arms ran");
  }
  const left = summaries[leftLabel];
  if (left === undefined) {
    throw new Error(`Missing summary for arm "${leftLabel}"`);
  }
  const rightLabel = labels[1];
  const right = rightLabel === undefined ? null : summaries[rightLabel] ?? null;
  const comparison = {
    arms: options.arms,
    compact: Object.fromEntries(
      armDefs.map((arm) => [arm.label, arm.compactOverride])
    ),
    deltas:
      right === null
        ? null
        : {
            cacheHitRate: left.cacheHitRate - right.cacheHitRate,
            inputTokens: left.inputTokens - right.inputTokens,
            passAtK: left.passAtK - right.passAtK,
            sessionCompactedEvents: left.sessionCompactedEvents - right.sessionCompactedEvents,
            successRate: left.successRate - right.successRate,
            totalTokens: left.totalTokens - right.totalTokens
          },
    generatedAt: new Date().toISOString(),
    left,
    mode: options.arms,
    provider: options.provider,
    repetitions: options.repetitions,
    right,
    suite: options.suite,
    taskIds: options.taskIds
  };

  const comparisonPath = join(outputRoot, "comparison.json");
  writeFileSync(comparisonPath, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");

  console.log(JSON.stringify(comparison, null, 2));
  for (const arm of armDefs) {
    console.error(`Wrote ${join(outputRoot, arm.dir, "eval-report.json")}`);
  }
  console.error(`Wrote ${comparisonPath}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
