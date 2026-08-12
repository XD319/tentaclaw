import { describe, expect, it } from "vitest";

import { collectPlatformToolIssues } from "../src/runtime/operations/runtime-doctor-service.js";

describe("runtime doctor platform issues", () => {
  it("warns when ripgrep is missing on Windows", () => {
    const issues = collectPlatformToolIssues({
      isCommandAvailable: (command) => command !== "rg",
      platform: "win32"
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("ripgrep (rg) is not on PATH"),
        expect.stringContaining("winget install BurntSushi.ripgrep.MSVC")
      ])
    );
  });

  it("warns when ripgrep is missing on Linux and macOS", () => {
    expect(
      collectPlatformToolIssues({
        isCommandAvailable: (command) => command !== "rg",
        platform: "linux"
      })
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("ripgrep (rg) is not on PATH"),
        expect.stringContaining("sudo apt install ripgrep")
      ])
    );
    expect(
      collectPlatformToolIssues({
        isCommandAvailable: (command) => command !== "rg",
        platform: "darwin"
      })
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("ripgrep (rg) is not on PATH"),
        expect.stringContaining("brew install ripgrep")
      ])
    );
  });

  it("warns when git is missing on Windows", () => {
    const issues = collectPlatformToolIssues({
      isCommandAvailable: (command) => command !== "git",
      platform: "win32"
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("git is not on PATH"),
        expect.stringContaining("winget install Git.Git")
      ])
    );
  });

  it("does not warn about git on non-Windows platforms", () => {
    const issues = collectPlatformToolIssues({
      isCommandAvailable: (command) => command !== "git",
      platform: "linux"
    });
    expect(issues.every((issue) => !issue.includes("git is not on PATH"))).toBe(true);
  });

  it("does not warn when ripgrep is available", () => {
    const issues = collectPlatformToolIssues({
      isCommandAvailable: () => true,
      platform: "linux"
    });
    expect(issues).toEqual([]);
  });
});
