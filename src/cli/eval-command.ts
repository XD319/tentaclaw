import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Command } from "commander";

import {
  replayTaskById,
  runBetaReadinessCheck,
  runCodingEvalReport,
  runReleaseChecklist
} from "../diagnostics/index.js";
import type { SupportedProviderName } from "../providers/index.js";
import {
  compareEvalReports,
  createEvalJudge,
  DEFAULT_COMPOUNDING_ACCUMULATED_ROOT,
  DEFAULT_COMPOUNDING_SUITE,
  runCapabilityEval,
  runCompoundingEval,
  writeEvalArtifacts,
  type CompoundingEvalReport,
  type EvalRunReport
} from "../evaluation/public.js";

import { formatSmokeSuiteReport, runSmokeSuite } from "../testing/index.js";
import {
  formatBetaReadinessReport,
  formatCodingEvalReport,
  formatReleaseChecklistReport,
  formatReplayReport
} from "./formatters.js";
import { parsePositiveIntegerOption, parseRatioOption } from "./cli-helpers.js";

interface SmokeCommandOptions {
  autoApprove: boolean;
  fixture?: string;
  provider: SupportedProviderName | "scripted-smoke";
  tasks?: string;
}

export function registerEvalCommands(program: Command): void {
  const smokeCommand = program.command("smoke").description("Run fixed runtime smoke tasks");

  program
    .command("replay")
    .argument("<task_id>", "Task identifier")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--from-iteration <number>", "Replay starting from this iteration", parsePositiveIntegerOption("--from-iteration"), 1)
    .option("--provider <mode>", "Replay provider mode: current | mock", "current")
    .option("--dry-run", "Show replay parameters without executing")
    .action(
      async (
        taskId: string,
        commandOptions: {
          cwd: string;
          dryRun?: boolean;
          fromIteration: number;
          provider: "current" | "mock";
        }
      ) => {
        if (commandOptions.dryRun === true) {
          console.log(
            `Replay dry-run: task=${taskId} cwd=${commandOptions.cwd} fromIteration=${commandOptions.fromIteration} provider=${commandOptions.provider}`
          );
          return;
        }
        const report = await replayTaskById(taskId, {
          cwd: commandOptions.cwd,
          fromIteration: commandOptions.fromIteration,
          providerMode: commandOptions.provider
        });
        console.log(formatReplayReport(report));
        if (report.replayTask.status === "failed" || report.replayTask.status === "cancelled") {
          process.exitCode = 1;
        }
      }
    );

  const evalCommand = program.command("eval").description("Run blind capability evals and compatibility diagnostics");

  evalCommand
    .command("run")
    .requiredOption("--provider <provider>", "Configured real provider to evaluate")
    .option("--suite <path>", "Versioned blind eval suite", "fixtures/eval-suites/internal-blind.v2.json")
    .option("--tasks <taskIds>", "Comma-separated blind task ids")
    .option("--repetitions <number>", "Trials per task", parsePositiveIntegerOption("--repetitions"), 3)
    .option("--judge-provider <provider>", "Optional non-blocking LLM judge provider")
    .option("--json", "Print JSON instead of text")
    .option("--output <directory>", "Write JSON, JUnit, and per-task artifacts")
    .action(async (commandOptions: {
      judgeProvider?: string;
      json?: boolean;
      output?: string;
      provider: string;
      repetitions: number;
      suite: string;
      tasks?: string;
    }) => {
      const report = await runCapabilityEval({
        ...(commandOptions.judgeProvider !== undefined
          ? { judge: createEvalJudge(process.cwd(), commandOptions.judgeProvider) }
          : {}),
        providerName: commandOptions.provider,
        repetitions: commandOptions.repetitions,
        suitePath: commandOptions.suite,
        taskIds: commandOptions.tasks?.split(",").map((value) => value.trim()).filter(Boolean) ?? []
      });
      if (commandOptions.output !== undefined) {
        const artifacts = await writeEvalArtifacts(report, commandOptions.output);
        console.error(`Eval artifacts: ${artifacts.jsonPath}, ${artifacts.junitPath}`);
      }
      console.log(commandOptions.json === true ? JSON.stringify(report, null, 2) : formatCapabilityEvalReport(report));
      if (!report.gate.passed) process.exitCode = 1;
    });

  evalCommand
    .command("compounding")
    .description("Run the same suite with empty vs accumulated skills and gate self-evolution regressions")
    .requiredOption("--provider <provider>", "Configured real provider to evaluate")
    .option("--suite <path>", "Compounding eval suite", DEFAULT_COMPOUNDING_SUITE)
    .option("--accumulated <path>", "Workspace overlay with accumulated skills", DEFAULT_COMPOUNDING_ACCUMULATED_ROOT)
    .option("--tasks <taskIds>", "Comma-separated task ids")
    .option("--repetitions <number>", "Trials per task per phase", parsePositiveIntegerOption("--repetitions"), 1)
    .option("--max-success-drop <number>", "Maximum allowed success-rate drop", parseRatioOption("--max-success-drop"), 0.05)
    .option("--max-passk-drop <number>", "Maximum allowed pass^k drop", parseRatioOption("--max-passk-drop"), 0.1)
    .option("--judge-provider <provider>", "Optional non-blocking LLM judge provider")
    .option("--json", "Print JSON instead of text")
    .option("--output <directory>", "Write empty and accumulated JSON artifacts")
    .action(async (commandOptions: {
      accumulated: string;
      judgeProvider?: string;
      json?: boolean;
      maxPasskDrop: number;
      maxSuccessDrop: number;
      output?: string;
      provider: string;
      repetitions: number;
      suite: string;
      tasks?: string;
    }) => {
      const report = await runCompoundingEval({
        accumulatedRoot: commandOptions.accumulated,
        compoundingThresholds: {
          maxPassPowerKDrop: commandOptions.maxPasskDrop,
          maxSuccessRateDrop: commandOptions.maxSuccessDrop
        },
        ...(commandOptions.judgeProvider !== undefined
          ? { judge: createEvalJudge(process.cwd(), commandOptions.judgeProvider) }
          : {}),
        providerName: commandOptions.provider,
        repetitions: commandOptions.repetitions,
        suitePath: commandOptions.suite,
        taskIds: commandOptions.tasks?.split(",").map((value) => value.trim()).filter(Boolean) ?? []
      });
      if (commandOptions.output !== undefined) {
        const emptyArtifacts = await writeEvalArtifacts(report.empty, `${commandOptions.output}/empty`);
        const accumulatedArtifacts = await writeEvalArtifacts(report.accumulated, `${commandOptions.output}/accumulated`);
        console.error(`Compounding artifacts: ${emptyArtifacts.jsonPath}, ${accumulatedArtifacts.jsonPath}`);
      }
      console.log(commandOptions.json === true ? JSON.stringify(report, null, 2) : formatCompoundingEvalReport(report));
      if (!report.gate.passed) process.exitCode = 1;
    });

  evalCommand
    .command("acceptance")
    .description("Run the reliability acceptance suite with verification/scope gate thresholds")
    .requiredOption("--provider <provider>", "Configured real provider to evaluate")
    .option("--suite <path>", "Acceptance suite", "fixtures/eval-suites/reliability-acceptance.v1.json")
    .option("--tasks <taskIds>", "Comma-separated task ids")
    .option("--repetitions <number>", "Trials per task", parsePositiveIntegerOption("--repetitions"), 1)
    .option("--min-verification-rate <number>", "Minimum verification completion rate", parseRatioOption("--min-verification-rate"), 0.5)
    .option("--max-scope-violation-rate <number>", "Maximum workspace scope violation rate", parseRatioOption("--max-scope-violation-rate"), 0.1)
    .option("--judge-provider <provider>", "Optional non-blocking LLM judge provider")
    .option("--json", "Print JSON instead of text")
    .option("--output <directory>", "Write JSON, JUnit, and per-task artifacts")
    .action(async (commandOptions: {
      judgeProvider?: string;
      json?: boolean;
      maxScopeViolationRate: number;
      minVerificationRate: number;
      output?: string;
      provider: string;
      repetitions: number;
      suite: string;
      tasks?: string;
    }) => {
      const report = await runCapabilityEval({
        gateThresholds: {
          maxWorkspaceScopeViolationRate: commandOptions.maxScopeViolationRate,
          minVerificationCompletionRate: commandOptions.minVerificationRate
        },
        ...(commandOptions.judgeProvider !== undefined
          ? { judge: createEvalJudge(process.cwd(), commandOptions.judgeProvider) }
          : {}),
        providerName: commandOptions.provider,
        repetitions: commandOptions.repetitions,
        suitePath: commandOptions.suite,
        taskIds: commandOptions.tasks?.split(",").map((value) => value.trim()).filter(Boolean) ?? []
      });
      if (commandOptions.output !== undefined) {
        const artifacts = await writeEvalArtifacts(report, commandOptions.output);
        console.error(`Eval artifacts: ${artifacts.jsonPath}, ${artifacts.junitPath}`);
      }
      console.log(commandOptions.json === true ? JSON.stringify(report, null, 2) : formatCapabilityEvalReport(report));
      if (!report.gate.passed) process.exitCode = 1;
    });

  evalCommand
    .command("compare")
    .requiredOption("--current <path>", "Current eval report")
    .requiredOption("--baseline <path>", "Approved baseline report")
    .option("--json", "Print JSON instead of text")
    .action((commandOptions: { baseline: string; current: string; json?: boolean }) => {
      const comparison = compareEvalReports(readEvalReport(commandOptions.current), readEvalReport(commandOptions.baseline));
      console.log(commandOptions.json === true ? JSON.stringify(comparison, null, 2) : [
        `Result: ${comparison.failed ? "failed" : "passed"}`,
        `Success delta: ${(comparison.deltas.successRate * 100).toFixed(1)}pp`,
        `Pass^k delta: ${(comparison.deltas.passPowerK * 100).toFixed(1)}pp`,
        ...comparison.failures.map((failure) => `FAIL ${failure}`),
        ...comparison.warnings.map((warning) => `WARN ${warning}`)
      ].join("\n"));
      if (comparison.failed) process.exitCode = 1;
    });

  evalCommand
    .command("baseline")
    .description("Manage approved eval baselines")
    .command("update")
    .requiredOption("--report <path>", "Passing eval report")
    .requiredOption("--output <path>", "Baseline output path")
    .action((commandOptions: { output: string; report: string }) => {
      const report = readEvalReport(commandOptions.report);
      if (!report.gate.passed) throw new Error("Cannot approve a failing eval report as baseline.");
      const outputPath = resolve(commandOptions.output);
      mkdirSync(dirname(outputPath), { recursive: true });
      copyFileSync(resolve(commandOptions.report), outputPath);
      console.log(`Baseline updated: ${outputPath}`);
    });

  evalCommand
    .command("smoke")
    .option("--provider <provider>", "Provider to use: scripted-smoke or any registered provider", "scripted-smoke")
    .option("--tasks <taskIds>", "Comma-separated smoke task ids")
    .option("--fixture <path>", "Custom fixture file path")
    .option("--no-auto-approve", "Do not auto-resolve approvals during smoke runs")
    .action(
      async (commandOptions: SmokeCommandOptions) => {
        console.warn("Warning: `talon eval smoke` is a compatibility alias; use `talon smoke run`.");
        await runSmokeCommand(commandOptions);
      }
    );

  evalCommand
    .command("coding")
    .option("--provider <provider>", "Provider to use: scripted-smoke or any registered provider", "scripted-smoke")
    .option("--tasks <taskIds>", "Comma-separated coding task ids")
    .option("--fixture <path>", "Custom fixture file path")
    .option("--min-success-rate <number>", "Minimum acceptable coding task success rate", parseRatioOption("--min-success-rate"), 0.8)
    .option("--json", "Print JSON instead of text")
    .option("--output <path>", "Write the report to a file")
    .action(
      async (commandOptions: {
        fixture?: string;
        json?: boolean;
        minSuccessRate: number;
        output?: string;
        provider: SupportedProviderName | "scripted-smoke";
        tasks?: string;
      }) => {
        console.warn("Warning: `talon eval coding` is a scripted compatibility diagnostic; use `talon eval run` for blind capability evaluation.");
        const report = await runCodingEvalReport({
          ...(commandOptions.fixture !== undefined
            ? { fixturePath: commandOptions.fixture }
            : {}),
          minimumSuccessRate: commandOptions.minSuccessRate,
          providerName: commandOptions.provider,
          taskIds:
            commandOptions.tasks?.split(",").map((value) => value.trim()).filter(Boolean) ?? []
        });
        const output = commandOptions.json === true
          ? JSON.stringify(report, null, 2)
          : formatCodingEvalReport(report);
        if (commandOptions.output !== undefined) {
          writeFileSync(commandOptions.output, `${output}\n`, "utf8");
        } else {
          console.log(output);
        }
        if (!report.betaGate.passed) {
          process.exitCode = 1;
        }
      }
    );

  const releaseCommand = program.command("release").description("Release readiness checks");
  releaseCommand
    .command("check")
    .option("--provider <provider>", "Provider to use for eval checks", "scripted-smoke")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--skip-quality-checks", "Skip lint, test, and build after running them separately")
    .action(async (commandOptions: {
      cwd: string;
      provider: SupportedProviderName | "scripted-smoke";
      skipQualityChecks?: boolean;
    }) => {
      const report = await runReleaseChecklist({
        cwd: commandOptions.cwd,
        onProgress: (message) => console.error(`[release] ${message}`),
        provider: commandOptions.provider,
        skipQualityChecks: commandOptions.skipQualityChecks === true
      });
      console.log(formatReleaseChecklistReport(report));
      if (!report.allPassed) {
        process.exitCode = 1;
      }
    });

  evalCommand
    .command("beta")
    .option("--provider <provider>", "Provider to use for sample eval: scripted-smoke or any registered provider", "scripted-smoke")
    .option("--min-success-rate <number>", "Minimum acceptable task success rate", parseRatioOption("--min-success-rate"), 0.8)
    .action(
      async (commandOptions: {
        minSuccessRate: number;
        provider: SupportedProviderName | "scripted-smoke";
      }) => {
        const report = await runBetaReadinessCheck({
          minimumSuccessRate: commandOptions.minSuccessRate,
          providerName: commandOptions.provider
        });
        console.log(formatBetaReadinessReport(report));
        if (!report.allPassed) {
          process.exitCode = 1;
        }
      }
    );

  smokeCommand
    .command("run")
    .option("--provider <provider>", "Provider to use: scripted-smoke or any registered provider", "scripted-smoke")
    .option("--tasks <taskIds>", "Comma-separated smoke task ids")
    .option("--fixture <path>", "Custom fixture file path")
    .option("--no-auto-approve", "Do not auto-resolve approvals during smoke runs")
    .action(async (commandOptions: SmokeCommandOptions) => {
      await runSmokeCommand(commandOptions);
    });
}

async function runSmokeCommand(commandOptions: SmokeCommandOptions): Promise<void> {
  const report = await runSmokeSuite({
    autoApprove: commandOptions.autoApprove,
    ...(commandOptions.fixture !== undefined
      ? { fixturePath: commandOptions.fixture }
      : {}),
    providerName: commandOptions.provider,
    taskIds:
      commandOptions.tasks?.split(",").map((value) => value.trim()).filter(Boolean) ?? []
  });
  console.log(formatSmokeSuiteReport(report));
  if (report.failedCount > 0) {
    process.exitCode = 1;
  }
}

function readEvalReport(path: string): EvalRunReport {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as EvalRunReport;
}

function formatCapabilityEvalReport(report: EvalRunReport): string {
  return [
    `Suite: ${report.suite.id}@${report.suite.version}`,
    `Provider: ${report.manifest.providerName}`,
    `Model: ${report.manifest.modelName ?? "-"}`,
    `Tasks: ${report.tasks.length}`,
    `Repetitions: ${report.manifest.repetitions}`,
    `Success rate: ${(report.metrics.successRate * 100).toFixed(1)}%`,
    `95% CI: ${(report.metrics.successRate95.low * 100).toFixed(1)}%-${(report.metrics.successRate95.high * 100).toFixed(1)}%`,
    `Pass@k: ${(report.metrics.passAtK * 100).toFixed(1)}%`,
    `Pass^k: ${(report.metrics.passPowerK * 100).toFixed(1)}%`,
    `Duration p50/p95: ${report.metrics.durationMs.p50.toFixed(0)}ms/${report.metrics.durationMs.p95.toFixed(0)}ms`,
    `Average rounds/tools: ${report.metrics.averageRounds.toFixed(2)}/${report.metrics.averageToolCalls.toFixed(2)}`,
    report.metrics.verificationCompletionRate === undefined ? "Verification completion: unavailable" : `Verification completion: ${(report.metrics.verificationCompletionRate * 100).toFixed(1)}%`,
    report.metrics.workspaceScopeViolationRate === undefined ? "Workspace scope violations: unavailable" : `Workspace scope violations: ${(report.metrics.workspaceScopeViolationRate * 100).toFixed(1)}%`,
    report.metrics.providerRecovery === undefined ? "Provider recovery: unavailable" : `Provider recovery: ${report.metrics.providerRecovery.recovered}/${report.metrics.providerRecovery.attempted}`,
    report.metrics.failureClassificationCounts === undefined ? "Failure classifications: unavailable" : `Failure classifications: ${Object.entries(report.metrics.failureClassificationCounts).map(([kind, count]) => `${kind}=${count}`).join(", ") || "none"}`,

    report.metrics.tokenUsage.available ? `Tokens: ${report.metrics.tokenUsage.totalTokens}` : "Tokens: unavailable",
    report.metrics.costUsd.available ? `Average cost: $${report.metrics.costUsd.average?.toFixed(6)}` : "Cost: unavailable",
    `Gate: ${report.gate.passed ? "passed" : "failed"}`,
    ...report.gate.reasons.map((reason) => `- ${reason}`)
  ].join("\n");
}

function formatCompoundingEvalReport(report: CompoundingEvalReport): string {
  return [
    `Empty ${formatCapabilityEvalReport(report.empty)}`,
    "",
    `Accumulated ${formatCapabilityEvalReport(report.accumulated)}`,
    "",
    `Success-rate delta: ${(report.deltas.successRate * 100).toFixed(1)}pp`,
    `Pass^k delta: ${(report.deltas.passPowerK * 100).toFixed(1)}pp`,
    `Average-rounds delta: ${report.deltas.averageRounds.toFixed(2)}`,
    report.deltas.tokensPerSuccess === null
      ? "Tokens-per-success delta: unavailable"
      : `Tokens-per-success delta: ${report.deltas.tokensPerSuccess.toFixed(1)}`,
    `Self-evolution gate: ${report.gate.passed ? "passed" : "failed"}`,
    ...report.gate.reasons.map((reason) => `- ${reason}`)
  ].join("\n");
}
