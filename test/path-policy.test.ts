import { describe, expect, it } from "vitest";

import { PathPolicy } from "../src/policy/path-policy.js";

describe("PathPolicy", () => {
  it("denies write paths that only match root by case on case-sensitive platforms", () => {
    if (process.platform === "win32") {
      return;
    }

    const pathPolicy = new PathPolicy({
      workspaceRoot: "/tmp/workspace"
    });

    expect(() => pathPolicy.resolveWritePath("/tmp/WorkSpace/escape.txt", "/tmp/workspace")).toThrow(
      /not within the configured write roots/i
    );
  });
});
