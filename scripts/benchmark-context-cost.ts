/**
 * Offline prompt-cost benchmark: naive vs governed vs optimized context governance.
 *
 * Uses a scripted provider (zero API cost) wrapped in PromptCostProbe to estimate
 * cumulative input tokens, simulated DeepSeek cache hit rate, and effective USD cost.
 *
 * Run:
 *   node --import tsx scripts/benchmark-context-cost.ts
 * Optional:
 *   --suite <path>     default fixtures/eval-suites/long-context.v1.json
 *   --tasks <ids>      comma-separated task subset (default: first task only)
 *   --output <dir>     default eval-artifacts/context-cost-offline
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  aggregateProbeReports,
  PromptCostProbe,
  type PromptCostProbeReport
} from "../src/diagnostics/prompt-cost-probe.js";
import { runCapabilityEval, type EvalRunReport } from "../src/evaluation/index.js";
import { loadEvalSuite, type EvalTask } from "../src/evaluation/schema.js";
import type { AppConfig } from "../src/runtime/index.js";
import type { Provider, ProviderInput, ProviderResponse, ProviderToolCall, TraceEvent } from "../src/types/index.js";

const DEFAULT_SUITE = "fixtures/eval-suites/long-context.v1.json";
const DEFAULT_OUTPUT = "eval-artifacts/context-cost-offline";

const COMPACT_ON: Partial<AppConfig["compact"]> = {
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

const COMPACT_OFF: Partial<AppConfig["compact"]> = {
  iterationThreshold: 1_000_000_000,
  messageThreshold: 1_000_000_000,
  minTokenPressureRatio: 0,
  summarizer: "deterministic",
  tokenThreshold: 1_000_000_000,
  toolCallThreshold: 1_000_000_000
};

interface ArmDefinition {
  compactOverride?: Partial<AppConfig["compact"]>;
  configOverride?: Partial<AppConfig>;
  label: string;
}

const ARMS: Record<string, ArmDefinition> = {
  governed: {
    label: "governed",
    compactOverride: COMPACT_ON
  },
  naive: {
    label: "naive",
    compactOverride: COMPACT_OFF,
    configOverride: {
      contextRetention: {
        maxBytesPerFile: 1_000_000,
        maxBytesPerFileUnderGuard: 1_000_000,
        maxFiles: 64,
        maxTotalBytes: 4_000_000,
        maxTotalBytesUnderGuard: 4_000_000,
        toolOutputMaxTokens: 1_000_000,
        toolResultKeepGroups: 1_000_000
      },
      tokenBudget: {
        inputLimit: 200_000,
        outputLimit: 8_000,
        reservedOutput: 1_000
      },
      tokenBudgetInputLimitExplicit: true
    }
  },
  optimized: {
    label: "optimized",
    compactOverride: {
      ...COMPACT_ON,
      minTokenPressureRatio: 0.5
    }
  }
};

interface ArmResult {
  arm: string;
  compactEvents: number;
  microPruneEvents: number;
  probe: PromptCostProbeReport;
  report: EvalRunReport;
}

function parseArgs(argv: string[]): {
  help: boolean;
  output: string;
  suite: string;
  taskIds: string[];
} {
  const options = {
    help: false,
    output: DEFAULT_OUTPUT,
    suite: DEFAULT_SUITE,
    taskIds: [] as string[]
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--suite":
        if (next === undefined) throw new Error("--suite requires a value");
        options.suite = next;
        index += 1;
        break;
      case "--tasks":
        if (next === undefined) throw new Error("--tasks requires a value");
        options.taskIds = next
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        index += 1;
        break;
      case "--output":
        if (next === undefined) throw new Error("--output requires a value");
        options.output = next;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function toolCall(
  toolName: string,
  input: Record<string, unknown>,
  step: number,
  reason: string
): ProviderResponse {
  const toolCalls: ProviderToolCall[] = [
    {
      input,
      reason,
      toolCallId: `script-${step}`,
      toolName
    }
  ];
  return {
    kind: "tool_calls",
    message: reason,
    toolCalls,
    usage: { inputTokens: 12, outputTokens: 8 }
  };
}

function createLongContextScriptedProvider(task: EvalTask): Provider {
  const readPaths = Object.keys(task.workspace.files)
    .filter((path) => /\.(?:mjs|js|md|json)$/u.test(path))
    .sort((left, right) => left.localeCompare(right));
  const writeTarget = task.scorers.find((scorer) => scorer.type === "workspace_diff")?.requiredPaths?.[0] ??
    "src/output.mjs";
  const writeContent =
    writeTarget.endsWith("math.mjs")
      ? "export function add(a, b) { return a + b; }\n"
      : "export default function output() { return true; }\n";

  let step = 0;

  return {
    model: "offline-scripted",
    name: "long-context-scripted",
    async generate(_input: ProviderInput): Promise<ProviderResponse> {
      step += 1;

      if (step <= readPaths.length * 3) {
        const path = readPaths[(step - 1) % readPaths.length]!;
        return toolCall("read_file", { path }, step, `Inspect ${path}`);
      }

      if (step === readPaths.length * 3 + 1) {
        return toolCall(
          "write_file",
          { content: writeContent, overwrite: true, path: writeTarget },
          step,
          `Create ${writeTarget}`
        );
      }

      if (step === readPaths.length * 3 + 2) {
        return toolCall(
          "shell",
          { command: `node -e "console.log('ok')"` },
          step,
          "Quick verification"
        );
      }

      if (step <= readPaths.length * 3 + 18) {
        const path = readPaths[(step - 3) % readPaths.length]!;
        return toolCall("read_file", { path }, step, `Re-read ${path}`);
      }

      return {
        kind: "final",
        message: "Completed scripted long-context trajectory.",
        usage: { inputTokens: 8, outputTokens: 6 }
      };
    }
  };
}

function countTraceEvents(trace: TraceEvent[], eventType: string): number {
  return trace.filter((event) => event.eventType === eventType).length;
}

async function runArm(
  armKey: string,
  arm: ArmDefinition,
  suitePath: string,
  taskIds: string[]
): Promise<ArmResult> {
  const suite = loadEvalSuite(suitePath);
  const tasks =
    taskIds.length === 0
      ? [suite.tasks[0]!]
      : taskIds.map((id) => suite.tasks.find((task) => task.id === id) ?? null);
  if (tasks.some((task) => task === null)) {
    throw new Error(`Unknown task id in --tasks`);
  }

  const probes: PromptCostProbe[] = [];
  const report = await runCapabilityEval({
    compactOverride: arm.compactOverride,
    configOverride: arm.configOverride,
    providerFactory: () => {
      const task = tasks[0] as EvalTask;
      const inner = createLongContextScriptedProvider(task);
      const probe = new PromptCostProbe(inner);
      probes.push(probe);
      return probe;
    },
    providerName: "mock",
    repetitions: 1,
    suitePath,
    taskIds: taskIds.length === 0 ? [suite.tasks[0]!.id] : taskIds
  });

  const allTraces = report.tasks.flatMap((task) => task.trials.flatMap((trial) => trial.trace));
  return {
    arm: armKey,
    compactEvents: countTraceEvents(allTraces, "session_compacted"),
    microPruneEvents: countTraceEvents(allTraces, "micro_compact_pruned"),
    probe: aggregateProbeReports(probes.map((probe) => probe.getReport())),
    report
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node --import tsx scripts/benchmark-context-cost.ts [options]`);
    return;
  }

  const outputDir = resolve(args.output);
  mkdirSync(outputDir, { recursive: true });

  const results: ArmResult[] = [];
  for (const [armKey, arm] of Object.entries(ARMS)) {
    console.log(`\n=== Running arm: ${arm.label} ===`);
    const result = await runArm(armKey, arm, resolve(args.suite), args.taskIds);
    results.push(result);
    writeFileSync(
      join(outputDir, `${armKey}.json`),
      `${JSON.stringify(
        {
          arm: armKey,
          compactEvents: result.compactEvents,
          microPruneEvents: result.microPruneEvents,
          probe: result.probe,
          successRate: result.report.metrics.successRate
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    console.log(
      JSON.stringify(
        {
          arm: armKey,
          cacheHitRate: pct(result.probe.cacheHitRate),
          compactEvents: result.compactEvents,
          effectiveCostUsd: usd(result.probe.effectiveCostUsd),
          microPruneEvents: result.microPruneEvents,
          totalInputTokens: result.probe.totalInputTokens
        },
        null,
        2
      )
    );
  }

  const naive = results.find((result) => result.arm === "naive");
  const governed = results.find((result) => result.arm === "governed");
  const optimized = results.find((result) => result.arm === "optimized");

  const comparison = {
    generatedAt: new Date().toISOString(),
    arms: results.map((result) => ({
      arm: result.arm,
      cacheHitRate: result.probe.cacheHitRate,
      compactEvents: result.compactEvents,
      effectiveCostUsd: result.probe.effectiveCostUsd,
      microPruneEvents: result.microPruneEvents,
      totalInputTokens: result.probe.totalInputTokens
    })),
    deltas: {
      governedVsNaive: governed && naive
        ? {
            cacheHitRateDelta: governed.probe.cacheHitRate - naive.probe.cacheHitRate,
            costUsdDelta: governed.probe.effectiveCostUsd - naive.probe.effectiveCostUsd,
            tokenDelta: governed.probe.totalInputTokens - naive.probe.totalInputTokens
          }
        : null,
      optimizedVsGoverned: optimized && governed
        ? {
            cacheHitRateDelta: optimized.probe.cacheHitRate - governed.probe.cacheHitRate,
            costUsdDelta: optimized.probe.effectiveCostUsd - governed.probe.effectiveCostUsd,
            compactEventsDelta: optimized.compactEvents - governed.compactEvents,
            tokenDelta: optimized.probe.totalInputTokens - governed.probe.totalInputTokens
          }
        : null
    }
  };

  writeFileSync(join(outputDir, "comparison.json"), `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
  console.log("\n=== Comparison ===");
  console.log(JSON.stringify(comparison, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
