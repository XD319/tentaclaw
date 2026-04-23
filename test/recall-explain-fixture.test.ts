import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MEMORY_SCOPES, TRACE_EVENT_TYPES, type TraceEvent } from "../src/types/index.js";

describe("recall explain fixture", () => {
  it("matches trace event and payload shape", () => {
    const fixture = JSON.parse(
      readFileSync(join(process.cwd(), "fixtures", "memory-layered", "recall_explain.sample.json"), "utf8")
    ) as TraceEvent;

    expect(TRACE_EVENT_TYPES).toContain(fixture.eventType);
    expect(fixture.eventType).toBe("recall_explain");
    const payload = fixture.payload as {
      candidateCount: number;
      items: Array<{ scope: string; selected: boolean; score: number; tokenEstimate: number; reason: string }>;
      selectedCount: number;
      skippedCount: number;
    };
    expect(payload.items.length).toBe(payload.candidateCount);
    expect(payload.selectedCount + payload.skippedCount).toBe(payload.candidateCount);
    expect(payload.items.every((item) => MEMORY_SCOPES.includes(item.scope as never))).toBe(true);
    expect(payload.items.every((item) => typeof item.reason === "string" && item.reason.length > 0)).toBe(true);
    expect(payload.items.every((item) => item.score >= 0 && item.tokenEstimate > 0)).toBe(true);
  });
});
