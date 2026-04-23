import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AUDIT_ACTIONS, AUDIT_OUTCOMES, MEMORY_SCOPES, TRACE_EVENT_TYPES, type AuditLogRecord, type TraceEvent } from "../src/types/index.js";

function readFixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(join(process.cwd(), "fixtures", "memory-layered", name), "utf8")
  ) as T;
}

describe("memory layered fixtures", () => {
  it("keeps trace samples aligned with event enums and layered scopes", () => {
    const recalled = readFixture<TraceEvent>("memory_recalled.sample.json");
    const written = readFixture<TraceEvent>("memory_written.sample.json");

    expect(TRACE_EVENT_TYPES).toContain(recalled.eventType);
    expect(TRACE_EVENT_TYPES).toContain(written.eventType);
    expect(recalled.eventType).toBe("memory_recalled");
    expect(written.eventType).toBe("memory_written");
    const recalledPayload = recalled.payload as { selectedScopes: string[] };
    const writtenPayload = written.payload as { scope: string };
    expect(recalledPayload.selectedScopes.every((scope) => MEMORY_SCOPES.includes(scope as never))).toBe(true);
    expect(MEMORY_SCOPES).toContain(writtenPayload.scope as never);
  });

  it("keeps audit sample aligned with audit enums", () => {
    const audit = readFixture<AuditLogRecord>("audit_review_resolved.sample.json");

    expect(AUDIT_ACTIONS).toContain(audit.action);
    expect(AUDIT_OUTCOMES).toContain(audit.outcome);
    const payload = audit.payload as { layer?: string };
    expect(payload.layer).toBe("profile");
  });
});
