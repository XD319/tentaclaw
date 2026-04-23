import { describe, expect, it } from "vitest";

import { loadSmokeTaskFixtures, runSmokeSuite } from "../src/testing/index.js";

describe("runtime smoke harness", () => {
  it("loads at least ten fixed smoke task fixtures", () => {
    const fixtures = loadSmokeTaskFixtures();

    expect(fixtures.length).toBeGreaterThanOrEqual(10);
    expect(new Set(fixtures.map((fixture) => fixture.taskId)).size).toBe(fixtures.length);
  });

  it("runs the full smoke task batch and generates an aggregate report", async () => {
    const report = await runSmokeSuite({
      providerName: "scripted-smoke"
    });

    expect(report.taskCount).toBeGreaterThanOrEqual(10);
    expect(report.failedCount).toBe(0);
    expect(report.succeededCount).toBe(report.taskCount);
    expect(report.averageRounds).toBeGreaterThan(0);
    expect(report.averageDurationMs).toBeGreaterThanOrEqual(0);
    expect(report.approvalTriggerCount).toBeGreaterThan(0);
    expect(report.toolCallSuccessRate).toBeGreaterThan(0.9);
  }, 30000);

  it("ignores ambient workspace and provider env while running scripted smoke tasks", async () => {
    const previousEnv = captureEnv([
      "AGENT_PROVIDER",
      "AGENT_PROVIDER_MAX_RETRIES",
      "AGENT_RUNTIME_DB_PATH",
      "AGENT_WORKSPACE_ROOT"
    ]);

    process.env.AGENT_PROVIDER = "openai";
    process.env.AGENT_PROVIDER_MAX_RETRIES = "99";
    process.env.AGENT_RUNTIME_DB_PATH = "broken-smoke.db";
    process.env.AGENT_WORKSPACE_ROOT = process.cwd();

    try {
      const report = await runSmokeSuite({
        providerName: "scripted-smoke",
        taskIds: ["single_read_project_summary", "multi_fix_after_failed_verification"]
      });

      expect(report.failedCount).toBe(0);
      expect(report.results.every((result) => result.success)).toBe(true);
    } finally {
      restoreEnv(previousEnv);
    }
  }, 20000);

  it("shows key trace phases for a multi-turn task", async () => {
    const report = await runSmokeSuite({
      providerName: "scripted-smoke",
      taskIds: ["multi_read_then_plan_write"]
    });

    const result = report.results[0];
    expect(result).toBeDefined();
    expect(result?.traceChecks.every((check) => check.ok)).toBe(true);
    expect(result?.keyTraceSummary.some((entry) => entry.includes("tool_call_requested"))).toBe(true);
    expect(result?.keyTraceSummary.some((entry) => entry.includes("policy_decision"))).toBe(true);
    expect(result?.keyTraceSummary.some((entry) => entry.includes("final_outcome"))).toBe(true);
  }, 15000);

  it("stably completes a repair-style multi-turn task", async () => {
    const report = await runSmokeSuite({
      providerName: "scripted-smoke",
      taskIds: ["multi_fix_after_failed_verification"]
    });

    const result = report.results[0];
    expect(result?.success).toBe(true);
    expect(result?.totalRounds).toBeGreaterThanOrEqual(4);
    expect(result?.toolCallSuccessRate).toBe(1);
  }, 15000);

  it("completes the search, patch, and verify smoke task across platforms", async () => {
    const report = await runSmokeSuite({
      providerName: "scripted-smoke",
      taskIds: ["multi_search_patch_verify"]
    });

    const result = report.results[0];
    expect(result?.success).toBe(true);
    expect(result?.failureReason).toBeNull();
    expect(result?.toolCallSuccessRate).toBe(1);
  }, 15000);

  it("triggers long-task compact or recall signals", async () => {
    const report = await runSmokeSuite({
      providerName: "scripted-smoke",
      taskIds: ["long_cross_file_review_with_compact", "long_memory_recall_followup"]
    });

    const compactTask = report.results.find(
      (result) => result.taskFixture.taskId === "long_cross_file_review_with_compact"
    );
    const recallTask = report.results.find(
      (result) => result.taskFixture.taskId === "long_memory_recall_followup"
    );

    expect(compactTask?.success).toBe(true);
    expect(compactTask?.traceChecks.find((check) => check.requirement === "session_compact_visible")?.ok).toBe(true);
    expect(recallTask?.success).toBe(true);
    expect(recallTask?.traceChecks.find((check) => check.requirement === "memory_recall_visible")?.ok).toBe(true);
  }, 15000);
});

function captureEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(previousEnv: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}
