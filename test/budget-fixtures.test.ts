import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("budget routing fixtures", () => {
  it("loads fixture samples", () => {
    const root = join(process.cwd(), "fixtures", "budget-routing");
    const route = JSON.parse(readFileSync(join(root, "route_decided.sample.json"), "utf8"));
    const warning = JSON.parse(readFileSync(join(root, "budget_warning.sample.json"), "utf8"));
    const exceeded = JSON.parse(readFileSync(join(root, "budget_exceeded.sample.json"), "utf8"));
    const audit = JSON.parse(readFileSync(join(root, "audit_budget_enforced.sample.json"), "utf8"));
    expect(route.eventType).toBe("route_decision");
    expect(warning.eventType).toBe("budget_warning");
    expect(exceeded.eventType).toBe("budget_exceeded");
    expect(audit.action).toBe("budget_exceeded");
  });
});
