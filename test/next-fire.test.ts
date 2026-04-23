import { describe, expect, it } from "vitest";

import { computeNextFireAt, parseEveryExpression } from "../src/runtime/scheduler/next-fire.js";

describe("scheduler next fire computation", () => {
  it("parses every expressions", () => {
    expect(parseEveryExpression("5m")).toBe(5 * 60 * 1000);
    expect(parseEveryExpression("2h")).toBe(2 * 60 * 60 * 1000);
  });

  it("computes interval and one-shot next fire", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const interval = computeNextFireAt({ cron: null, intervalMs: 60_000, timezone: null }, from);
    expect(interval?.toISOString()).toBe("2026-01-01T00:01:00.000Z");
    const oneShot = computeNextFireAt({ cron: null, intervalMs: null, timezone: null }, from);
    expect(oneShot).toBeNull();
  });

  it("computes cron next fire", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const next = computeNextFireAt({ cron: "*/5 * * * *", intervalMs: null, timezone: "UTC" }, from);
    expect(next?.toISOString()).toBe("2026-01-01T00:05:00.000Z");
  });
});
