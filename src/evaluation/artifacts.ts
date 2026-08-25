import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";

import type { EvalRunReport } from "./types.js";

export async function writeEvalArtifacts(report: EvalRunReport, outputDirectory: string): Promise<{
  jsonPath: string;
  junitPath: string;
  markdownPath: string;
}> {
  const directory = resolve(outputDirectory);
  await fs.mkdir(directory, { recursive: true });
  const jsonPath = join(directory, "eval-report.json");
  const junitPath = join(directory, "eval-report.junit.xml");
  const markdownPath = join(directory, "eval-report.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(junitPath, toJunit(report), "utf8");
  await fs.writeFile(markdownPath, toMarkdown(report), "utf8");
  await fs.mkdir(join(directory, "tasks"), { recursive: true });
  for (const task of report.tasks) {
    await fs.writeFile(join(directory, "tasks", `${safeName(task.task.id)}.json`), `${JSON.stringify(task, null, 2)}\n`, "utf8");
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath !== undefined && summaryPath.length > 0) {
    await fs.appendFile(summaryPath, `${toMarkdown(report)}\n`, "utf8");
  }
  return { jsonPath, junitPath, markdownPath };
}

export function toMarkdown(report: EvalRunReport): string {
  const lines = [
    `# Eval report: ${report.suite.id}@${report.suite.version}`,
    "",
    `- Provider: ${report.manifest.providerName} / ${report.manifest.modelName ?? "-"}`,
    `- Repetitions: ${report.manifest.repetitions} (pass@k size ${report.manifest.passAtKSize ?? report.manifest.repetitions})`,
    `- Success rate: ${(report.metrics.successRate * 100).toFixed(1)}% (95% CI ${(report.metrics.successRate95.low * 100).toFixed(1)}%–${(report.metrics.successRate95.high * 100).toFixed(1)}%)`,
    `- Pass@k / pass^k: ${(report.metrics.passAtK * 100).toFixed(1)}% / ${(report.metrics.passPowerK * 100).toFixed(1)}%`,
    `- Gate: ${report.gate.passed ? "passed" : "failed"}`,
    `- Scorable trials: ${report.metrics.scorableTrialCount ?? "n/a"}; harness errors: ${((report.metrics.harnessErrorRate ?? 0) * 100).toFixed(1)}%`,
    ""
  ];
  if (report.gate.reasons.length > 0) {
    lines.push("## Gate reasons", ...report.gate.reasons.map((reason) => `- ${reason}`), "");
  }
  if ((report.metrics.grouped ?? []).length > 0) {
    lines.push("## Grouped success rates");
    for (const group of report.metrics.grouped) {
      lines.push(`- ${group.kind} \`${group.key}\`: ${(group.successRate * 100).toFixed(1)}% (n=${group.trialCount})`);
    }
    lines.push("");
  }
  if (report.metrics.paired !== undefined) {
    const paired = report.metrics.paired;
    lines.push(
      "## Memory pairing (cold → warm relative reduction)",
      `- tokens: ${(paired.inputTokens.mean * 100).toFixed(1)}% [${(paired.inputTokens.low * 100).toFixed(1)}%, ${(paired.inputTokens.high * 100).toFixed(1)}%]`,
      `- rounds: ${(paired.rounds.mean * 100).toFixed(1)}%`,
      `- tool calls: ${(paired.toolCallCount.mean * 100).toFixed(1)}%`,
      `- recall@k: ${paired.recallAtK === null ? "n/a" : `${(paired.recallAtK * 100).toFixed(1)}%`}`,
      `- poison-following: ${paired.poisonFollowingRate === null ? "n/a" : `${(paired.poisonFollowingRate * 100).toFixed(1)}%`}`,
      ""
    );
  }
  lines.push("## Tasks");
  for (const task of report.tasks) {
    const arm = task.arm === undefined ? "" : ` [${task.arm}]`;
    lines.push(`- ${task.task.id}${arm}: ${(task.successRate * 100).toFixed(0)}% (${task.task.category}/${task.task.difficulty})`);
  }
  return `${lines.join("\n")}\n`;
}

function toJunit(report: EvalRunReport): string {
  const trials = report.tasks.flatMap((task) => task.trials.map((trial) => ({ task, trial })));
  const failures = trials.filter(({ trial }) => !trial.success).length;
  const cases = trials.map(({ task, trial }) => {
    const failure = trial.success ? "" : `<failure type="${escapeXml(trial.failureClassification ?? "unknown")}" message="eval failed">${escapeXml(trial.scorerResults.filter((score) => score.required && !score.passed).map((score) => `${score.id}: ${score.evidence}`).join("\n"))}</failure>`;
    return `<testcase classname="${escapeXml(task.task.category)}" name="${escapeXml(`${task.task.id}#${trial.trial}`)}" time="${(trial.durationMs / 1000).toFixed(3)}">${failure}</testcase>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${escapeXml(report.suite.id)}" tests="${trials.length}" failures="${failures}">${cases}</testsuite>\n`;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function safeName(value: string): string { return value.replace(/[^a-zA-Z0-9._-]/g, "_"); }
