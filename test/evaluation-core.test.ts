import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  compareEvalReports,
  evalSuiteManifestSchema,
  loadEvalSuite,
  passAtK,
  passPowerK,
  runCapabilityEval,
  runRecallProbe,
  validateEvalSuite,
  wilsonInterval,
  writeEvalArtifacts,
  type EvalRunReport,
  type EvalSuiteManifest,
  type EvalTask
} from "../src/evaluation/public.js";
import { TOOLSET_TOOLS } from "../src/tools/toolsets.js";
import type { Provider, ProviderInput, ProviderResponse } from "../src/types/index.js";
import { runSmokeSuite } from "../src/testing/index.js";

const KNOWN_TOOLS = new Set(Object.values(TOOLSET_TOOLS).flat());
const EVAL_SUITE_PATHS = [
  "fixtures/eval-suites/internal-blind.v1.json",
  "fixtures/eval-suites/internal-blind.v2.json",
  "fixtures/eval-suites/reliability-acceptance.v1.json",
  "fixtures/eval-suites/memory-compounding.v1.json"
] as const;

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (path !== undefined) await fs.rm(path, { force: true, recursive: true });
  }
});

describe("evaluation core", () => {
  it("loads the versioned thirty-task blind suite", () => {
    const suite = loadEvalSuite("fixtures/eval-suites/internal-blind.v1.json");
    expect(suite.schemaVersion).toBe(1);
    expect(suite.tasks).toHaveLength(30);
    expect(new Set(suite.tasks.map((task) => task.id)).size).toBe(30);
    expect(suite.tasks.every((task) => task.scorers.some((scorer) => scorer.required && scorer.type !== "llm_judge"))).toBe(true);
  });

  it("keeps v1 stable and adds five reliability tasks in v2", () => {
    const suite = loadEvalSuite("fixtures/eval-suites/internal-blind.v2.json");
    expect(suite.version).toBe("2.0.0");
    expect(suite.tasks).toHaveLength(35);
    expect(suite.tasks.map((task) => task.id)).toEqual(expect.arrayContaining([
      "reliability_timeout_recovery", "reliability_shell_correction", "reliability_verify_cleanup", "reliability_empty_string_boundary", "reliability_counter_contract"
    ]));
  });

  it("loads the reliability acceptance suite", () => {
    const suite = loadEvalSuite("fixtures/eval-suites/reliability-acceptance.v1.json");
    expect(suite.id).toBe("auto-talon-reliability-acceptance");
    expect(suite.tasks).toHaveLength(20);
    expect(suite.tasks.every((task) => task.scorers.some((scorer) => scorer.required && scorer.type !== "llm_judge"))).toBe(true);
  });

  it("uses only registered tool names in suite scorers", () => {
    for (const path of EVAL_SUITE_PATHS) {
      const suite = loadEvalSuite(path);
      for (const name of namedToolsFromSuite(suite)) {
        expect(KNOWN_TOOLS.has(name), `${path} unknown tool "${name}"`).toBe(true);
      }
    }
  });

  it("does not leak hidden scorer files or task ids into model-facing prompts", () => {
    for (const path of EVAL_SUITE_PATHS) {
      const suite = loadEvalSuite(path);
      for (const task of suite.tasks) {
        expect(task.input).not.toContain(".eval-hidden");
        expect(task.input).not.toContain(task.id);
      }
    }
  });

  it("rejects duplicate tasks and judge-only grading", () => {
    const task = {
      capabilities: ["answer"],
      category: "test",
      id: "duplicate",
      input: "answer",
      scorers: [{ id: "judge", required: false, rubric: "good", type: "llm_judge" }],
      title: "Duplicate"
    };
    expect(() => evalSuiteManifestSchema.parse({
      description: "invalid",
      id: "invalid",
      schemaVersion: 1,
      tasks: [task, task],
      version: "1"
    })).toThrow(/deterministic|required|unique/i);
    expect(() => evalSuiteManifestSchema.parse({
      description: "invalid",
      id: "invalid",
      schemaVersion: 1,
      tasks: [],
      unexpected: true,
      version: "1"
    })).toThrow();
  });

  it("computes reliability and confidence metrics", () => {
    expect(passAtK(2, 3, 3)).toBe(1);
    expect(passPowerK(2, 3, 3)).toBeCloseTo(8 / 27);
    const interval = wilsonInterval(8, 10);
    expect(interval.low).toBeLessThan(0.8);
    expect(interval.high).toBeGreaterThan(0.8);
  });

  it("runs blind repetitions without leaking fixture identity or graders", async () => {
    const root = await makeTempDirectory("eval-suite-");
    const suitePath = join(root, "suite.json");
    await fs.writeFile(suitePath, JSON.stringify({
      description: "test suite",
      id: "blind-test",
      schemaVersion: 1,
      tasks: [{
        capabilities: ["answer"],
        category: "test",
        id: "secret-fixture-id",
        input: "Reply READY",
        scorers: [{ contains: ["READY"], id: "secret-scorer", type: "output" }],
        title: "Blind answer"
      }],
      version: "1"
    }), "utf8");
    const observed: ProviderInput[] = [];
    const report = await runCapabilityEval({
      configCwd: process.cwd(),
      providerFactory: () => new FinalProvider(observed),
      providerName: "test-provider",
      repetitions: 3,
      suitePath
    });
    expect(report.gate.passed).toBe(true);
    expect(report.metrics.successRate).toBe(1);
    expect(report.tasks[0]?.trials).toHaveLength(3);
    expect(observed).toHaveLength(3);
    for (const input of observed) {
      expect(input.task.taskId).not.toBe("secret-fixture-id");
      expect(JSON.stringify(input.task.metadata)).not.toContain("secret-scorer");
      expect(JSON.stringify(input.messages)).not.toContain("secret-fixture-id");
    }
  });

  it("keeps the run gate passing when a low-risk required scorer misses", async () => {
    const report = await runMissedOutputEval({
      capabilities: ["coding"],
      id: "coding-miss",
      risk: "low",
      title: "Coding miss"
    });
    expect(report.gate.passed).toBe(true);
    expect(report.metrics.successRate).toBe(0);
    expect(report.tasks[0]?.trials[0]?.success).toBe(false);
  });

  it("fails the run gate when a high-risk required scorer misses", async () => {
    const report = await runMissedOutputEval({
      capabilities: ["safety"],
      id: "safety-miss",
      risk: "high",
      title: "Safety miss"
    });
    expect(report.gate.passed).toBe(false);
    expect(report.gate.reasons).toEqual(expect.arrayContaining(["safety-miss#1:output"]));
    expect(report.metrics.successRate).toBe(0);
  });

  it("compares baselines and writes machine-readable artifacts", async () => {
    const baseline = reportFixture({ duration: 100, passPowerK: 1, successRate: 1 });
    const current = reportFixture({ duration: 140, passPowerK: 0.8, successRate: 0.9 });
    const comparison = compareEvalReports(current, baseline);
    expect(comparison.failed).toBe(true);
    expect(comparison.warnings).toEqual([expect.stringContaining("p95")]);
    const output = await makeTempDirectory("eval-artifacts-");
    const paths = await writeEvalArtifacts(baseline, output);
    expect(await fs.readFile(paths.jsonPath, "utf8")).toContain("blind-test");
    expect(await fs.readFile(paths.junitPath, "utf8")).toContain("testsuite");
  });

  it("fails fast for unknown smoke task ids", async () => {
    await expect(runSmokeSuite({ providerName: "scripted-smoke", taskIds: ["missing-task"] }))
      .rejects.toThrow(/Unknown smoke task ids/);
  });

  it("attaches oracles to every first-party blind task", () => {
    const suite = loadEvalSuite("fixtures/eval-suites/internal-blind.v2.json");
    expect(suite.tasks.every((task) => task.oracle !== undefined)).toBe(true);
  });

  it("keeps shared task definitions aligned across suites", () => {
    const v1 = loadEvalSuite("fixtures/eval-suites/internal-blind.v1.json");
    const v2 = loadEvalSuite("fixtures/eval-suites/internal-blind.v2.json");
    const acceptance = loadEvalSuite("fixtures/eval-suites/reliability-acceptance.v1.json");
    const v2ById = new Map(v2.tasks.map((task) => [task.id, task]));
    for (const suite of [v1, acceptance]) {
      for (const task of suite.tasks) {
        const canonical = v2ById.get(task.id);
        expect(canonical, `missing ${task.id} in v2`).toBeDefined();
        expect(stableTask(task)).toEqual(stableTask(canonical!));
      }
    }
  });

  it("validates oracles and rejects a null-agent-solvable task", async () => {
    const report = await validateEvalSuite("fixtures/eval-suites/internal-blind.v2.json");
    expect(report.passed, report.issues.map((issue) => `${issue.taskId}:${issue.kind}:${issue.evidence}`).join("\n")).toBe(true);
    const memoryReport = await validateEvalSuite("fixtures/eval-suites/memory-compounding.v1.json");
    expect(memoryReport.passed, memoryReport.issues.map((issue) => `${issue.taskId}:${issue.kind}:${issue.evidence}`).join("\n")).toBe(true);
  });

  it("rejects baseline comparison when the suite version drifts", () => {
    const baseline = reportFixture({ duration: 100, passPowerK: 1, successRate: 1 });
    const current = reportFixture({ duration: 100, passPowerK: 1, successRate: 1 });
    current.manifest.suiteVersion = "9.0.0";
    expect(() => compareEvalReports(current, baseline)).toThrow(/not comparable|suiteVersion/i);
    const allowed = compareEvalReports(current, baseline, { allowDrift: true });
    expect(allowed.warnings.some((warning) => warning.includes("suiteVersion"))).toBe(true);
  });

  it("recalls and injects warm memories without a model call", async () => {
    const suite = loadEvalSuite("fixtures/eval-suites/memory-compounding.v1.json");
    const probe = await runRecallProbe({
      expectedTitles: ["Project indent convention"],
      k: 6,
      memoryState: suite.memoryEval!.arms.warm,
      query: "Follow the project indent convention when editing TypeScript files."
    });
    expect(probe.recalledTitles).toContain("Project indent convention");
    expect(probe.injected).toBe(true);
    expect(probe.recallAtK).toBeGreaterThan(0);
  });
});

class FinalProvider implements Provider {
  public readonly name = "blind-test-provider";
  public readonly model = "blind-test-model";

  public constructor(
    private readonly observed: ProviderInput[],
    private readonly message = "READY"
  ) {}

  public generate(input: ProviderInput): Promise<ProviderResponse> {
    this.observed.push(input);
    return Promise.resolve({
      kind: "final",
      message: this.message,
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 }
    });
  }
}

async function runMissedOutputEval(task: {
  capabilities: string[];
  id: string;
  risk: "low" | "medium" | "high";
  title: string;
}): Promise<EvalRunReport> {
  const root = await makeTempDirectory("eval-gate-");
  const suitePath = join(root, "suite.json");
  await fs.writeFile(suitePath, JSON.stringify({
    description: "gate suite",
    id: "gate-test",
    schemaVersion: 1,
    tasks: [{
      capabilities: task.capabilities,
      category: "test",
      id: task.id,
      input: "Reply READY",
      risk: task.risk,
      scorers: [{ contains: ["READY"], id: "output", type: "output" }],
      title: task.title
    }],
    version: "1"
  }), "utf8");
  return runCapabilityEval({
    configCwd: process.cwd(),
    providerFactory: () => new FinalProvider([], "MISS"),
    providerName: "test-provider",
    repetitions: 1,
    suitePath
  });
}

function namedToolsFromSuite(suite: EvalSuiteManifest): string[] {
  return suite.tasks.flatMap((task) => task.scorers.flatMap((scorer) => {
    if (scorer.type !== "tool_trace") {
      return [];
    }
    return [...scorer.requiredTools, ...scorer.forbiddenTools, ...Object.keys(scorer.requiredArguments)];
  }));
}

async function makeTempDirectory(prefix: string): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), prefix));
  tempPaths.push(path);
  return path;
}

function stableTask(task: EvalTask): unknown {
  return {
    approvalMode: task.approvalMode,
    capabilities: task.capabilities,
    category: task.category,
    difficulty: task.difficulty,
    input: task.input,
    oracle: task.oracle,
    profile: task.profile,
    risk: task.risk,
    scorers: task.scorers,
    timeoutMs: task.timeoutMs,
    title: task.title,
    workspace: task.workspace
  };
}

function reportFixture(input: { duration: number; passPowerK: number; successRate: number }): EvalRunReport {
  return {
    gate: { passed: true, reasons: [] },
    manifest: {
      codeSha: "abc",
      datasetSha256: "dataset",
      generatedAt: "2026-01-01T00:00:00.000Z",
      modelName: "model",
      nodeVersion: process.version,
      passAtKSize: 1,
      platform: process.platform,
      promptVersion: "1",
      providerName: "provider",
      repetitions: 1,
      sampling: {
        contextWindowTokens: null,
        maxRetries: 2,
        modelName: "model",
        streamIdleTimeoutMs: 30_000,
        timeoutMs: 60_000
      },
      suiteId: "blind-test",
      suiteVersion: "1",
      toolSchemaVersion: "1"
    },
    metrics: {
      averageRounds: 1,
      averageToolCalls: 0,
      durationMs: { p50: input.duration, p95: input.duration },
      grouped: [],
      harnessErrorRate: 0,
      passAtK: input.successRate,
      costUsd: { available: false, average: null, coverage: 0, total: null },
      passPowerK: input.passPowerK,
      scorableTrialCount: 0,
      standardError: 0,
      successRate: input.successRate,
      successRate95: { high: 1, low: 0 },
      tokenUsage: { available: true, cachedInputTokens: 0, inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    },
    suite: { description: "test", id: "blind-test", version: "1" },
    tasks: []
  };
}
