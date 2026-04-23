import { describe, expect, it } from "vitest";

import { runBetaReadinessCheck } from "../src/diagnostics/index.js";

describe("beta readiness", () => {
  it("returns a structured checklist with concrete gate results", async () => {
    const report = await runBetaReadinessCheck({
      minimumSuccessRate: 0.8,
      providerName: "scripted-smoke"
    });

    expect(typeof report.generatedAt).toBe("string");
    expect(Array.isArray(report.checklist)).toBe(true);
    expect(report.checklist.length).toBeGreaterThanOrEqual(6);
    expect(report.checklist.every((item) => typeof item.id === "string")).toBe(true);
    expect(report.checklist.every((item) => typeof item.ok === "boolean")).toBe(true);
    expect(report.checklist.some((item) => item.id === "provider-errors-diagnosable")).toBe(true);
    expect(report.checklist.some((item) => item.id === "external-adapter-path")).toBe(true);
  }, 40000);
});
