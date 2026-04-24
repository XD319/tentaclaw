import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("tool exposure fixture", () => {
  it("has expected tool_exposure_decided shape", () => {
    const fixturePath = join(
      process.cwd(),
      "fixtures",
      "tool-exposure",
      "tool_exposure_decided.sample.json"
    );
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
    expect(fixture.eventType).toBe("tool_exposure_decided");
    const payload = fixture.payload as Record<string, unknown>;
    expect(Array.isArray(payload.exposedTools)).toBe(true);
    expect(Array.isArray(payload.hiddenTools)).toBe(true);
    expect(Array.isArray(payload.decisions)).toBe(true);
  });
});
