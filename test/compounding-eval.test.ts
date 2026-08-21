import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  compareCompoundingReports,
  loadEvalSuite,
  loadWorkspaceOverlay,
  runCompoundingEval
} from "../src/evaluation/public.js";
import type { Provider, ProviderInput, ProviderResponse } from "../src/types/index.js";
import type { EvalRunReport } from "../src/evaluation/types.js";

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (path !== undefined) await fs.rm(path, { force: true, recursive: true });
  }
});

describe("compounding eval", () => {
  it("loads the compounding suite and accumulated skill overlay without paid models", async () => {
    const suite = loadEvalSuite("fixtures/eval-suites/compounding-self-evolution.v1.json");
    expect(suite.id).toBe("auto-talon-compounding-self-evolution");
    expect(suite.tasks).toHaveLength(6);
    expect(suite.tasks.every((task) => task.scorers.some((scorer) => scorer.required && scorer.type !== "llm_judge"))).toBe(true);
    expect(suite.tasks.every((task) => task.capabilities.includes("skill_reuse"))).toBe(true);

    const overlay = await loadWorkspaceOverlay("fixtures/eval-compounding/accumulated");
    expect(Object.keys(overlay).some((path) => path.includes(".auto-talon/skills/project/slug_convention/SKILL.md"))).toBe(true);
  });

  it("does not leak hidden scorer files or task ids into the model-facing prompt", () => {
    const suite = loadEvalSuite("fixtures/eval-suites/compounding-self-evolution.v1.json");
    for (const task of suite.tasks) {
      expect(task.input).not.toContain(".eval-hidden");
      expect(task.input).not.toContain(task.id);
    }
  });

  it("gates self-evolution regressions and records empty vs accumulated deltas", async () => {
    const root = await makeTempDirectory("compounding-suite-");
    const suitePath = join(root, "suite.json");
    const accumulatedRoot = join(root, "accumulated");
    await fs.mkdir(join(accumulatedRoot, ".auto-talon/skills/project/slug_convention"), { recursive: true });
    await fs.writeFile(
      join(accumulatedRoot, ".auto-talon/skills/project/slug_convention/SKILL.md"),
      "---\n{\"name\":\"slug_convention\",\"namespace\":\"project\",\"description\":\"qv7n2k unique skill marker for compounding eval\"}\n---\n",
      "utf8"
    );
    await fs.writeFile(suitePath, JSON.stringify({
      description: "compounding",
      id: "compounding-test",
      schemaVersion: 1,
      tasks: [{
        capabilities: ["skill_reuse"],
        category: "test",
        id: "secret-compounding-id",
        input: "Reply with the status for qv7n2k",
        scorers: [{ contains: ["SKILL-HIT"], id: "secret-scorer", type: "output" }],
        title: "Skill reuse"
      }],
      version: "1"
    }), "utf8");

    const report = await runCompoundingEval({
      accumulatedRoot,
      compoundingThresholds: { maxSuccessRateDrop: 0, maxPassPowerKDrop: 0 },
      configCwd: process.cwd(),
      providerFactory: () => new SkillAwareProvider(),
      providerName: "test-provider",
      repetitions: 1,
      suitePath
    });

    expect(report.empty.metrics.successRate).toBe(0);
    expect(report.accumulated.metrics.successRate).toBe(1);
    expect(report.deltas.successRate).toBe(1);
    expect(report.gate.passed).toBe(true);
  });

  it("fails the self-evolution gate when accumulated success regresses", () => {
    const empty = reportFixture({ passPowerK: 1, successRate: 1 });
    const accumulated = reportFixture({ passPowerK: 0.2, successRate: 0.4 });
    const comparison = compareCompoundingReports(empty, accumulated, {
      maxPassPowerKDrop: 0.1,
      maxSuccessRateDrop: 0.05
    });
    expect(comparison.gate.passed).toBe(false);
    expect(comparison.gate.reasons.some((reason) => /success rate dropped/u.test(reason))).toBe(true);
  });
});

class SkillAwareProvider implements Provider {
  public readonly name = "skill-aware-provider";
  public readonly model = "skill-aware-model";

  public generate(input: ProviderInput): Promise<ProviderResponse> {
    const blob = JSON.stringify(input.messages);
    const hasSkill = blob.includes("qv7n2k unique skill marker");
    return Promise.resolve({
      kind: "final",
      message: hasSkill ? "SKILL-HIT" : "SKILL-MISS",
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 }
    });
  }
}

async function makeTempDirectory(prefix: string): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), prefix));
  tempPaths.push(path);
  return path;
}

function reportFixture(input: { passPowerK: number; successRate: number }): EvalRunReport {
  return {
    gate: { passed: true, reasons: [] },
    manifest: {
      codeSha: "abc",
      datasetSha256: "dataset",
      generatedAt: "2026-01-01T00:00:00.000Z",
      modelName: "model",
      nodeVersion: process.version,
      platform: process.platform,
      promptVersion: "1",
      providerName: "provider",
      repetitions: 1,
      suiteId: "compounding-test",
      suiteVersion: "1",
      toolSchemaVersion: "1"
    },
    metrics: {
      averageRounds: 1,
      averageToolCalls: 0,
      durationMs: { p50: 10, p95: 10 },
      passAtK: input.successRate,
      costUsd: { available: false, average: null, total: null },
      passPowerK: input.passPowerK,
      standardError: 0,
      successRate: input.successRate,
      successRate95: { high: 1, low: 0 },
      tokenUsage: { available: true, cachedInputTokens: 0, inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    },
    suite: { description: "test", id: "compounding-test", version: "1" },
    tasks: []
  };
}
