import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("budget routing fixtures", () => {
  it("loads fixture samples", () => {
    const root = join(process.cwd(), "fixtures", "budget-routing");
    const route = readFixture(root, "route_decided.sample.json");
    const warning = readFixture(root, "budget_warning.sample.json");
    const exceeded = readFixture(root, "budget_exceeded.sample.json");
    const audit = readFixture(root, "audit_budget_enforced.sample.json");
    expect(route.eventType).toBe("route_decision");
    expect(warning.eventType).toBe("budget_warning");
    expect(exceeded.eventType).toBe("budget_exceeded");
    expect(audit.action).toBe("budget_exceeded");
  });
});

function readFixture(root: string, fileName: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(root, fileName), "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new TypeError(`Fixture ${fileName} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}
