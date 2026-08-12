import { describe, expect, it } from "vitest";

import {
  formatRipgrepFallbackSummarySuffix,
  formatRipgrepMissingDoctorIssue,
  isRipgrepMissingProcessError,
  ripgrepInstallHint
} from "../src/core/ripgrep.js";

describe("ripgrep guidance", () => {
  it("returns platform-specific install hints", () => {
    expect(ripgrepInstallHint("win32")).toContain("winget install BurntSushi.ripgrep.MSVC");
    expect(ripgrepInstallHint("darwin")).toContain("brew install ripgrep");
    expect(ripgrepInstallHint("linux")).toContain("sudo apt install ripgrep");
  });

  it("formats doctor and fallback messages with actionable guidance", () => {
    expect(formatRipgrepMissingDoctorIssue("win32")).toContain("ripgrep (rg) is not on PATH");
    expect(formatRipgrepMissingDoctorIssue("linux")).toContain("sudo apt install ripgrep");
    expect(formatRipgrepFallbackSummarySuffix("darwin")).toContain("ripgrep unavailable");
    expect(formatRipgrepFallbackSummarySuffix("darwin")).toContain("brew install ripgrep");
  });

  it("detects ENOENT-style missing process errors", () => {
    expect(isRipgrepMissingProcessError({ code: "ENOENT" })).toBe(true);
    expect(isRipgrepMissingProcessError({ errno: -2 })).toBe(true);
    expect(isRipgrepMissingProcessError({ code: "EACCES" })).toBe(false);
    expect(isRipgrepMissingProcessError(new Error("boom"))).toBe(false);
  });
});
