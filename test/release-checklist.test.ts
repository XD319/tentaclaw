import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  validatePackageMetadata,
  validatePackContents,
  validateReleaseRepository
} from "../src/diagnostics";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined && existsSync(tempPath)) {
      rmSync(tempPath, { force: true, recursive: true });
    }
  }
});

describe("release checklist helpers", () => {
  it("recognizes this repository as the release root", () => {
    expect(validateReleaseRepository(process.cwd())).toEqual({
      details: "auto-talon repository root",
      ok: true
    });
  });

  it("rejects non-auto-talon workspaces before running release commands", () => {
    const workspace = createTempDir("auto-talon-release-other-");
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({ name: "other-project" }, null, 2),
      "utf8"
    );

    const result = validateReleaseRepository(workspace);

    expect(result.ok).toBe(false);
    expect(result.details).toContain("maintainer-only");
  });

  it("requires public npm metadata", () => {
    expect(validatePackageMetadata(process.cwd())).toEqual({
      details: "public npm metadata present",
      ok: true
    });
  });

  it("rejects development files in the npm pack manifest", () => {
    const result = validatePackContents([
      "package.json",
      "README.md",
      "CHANGELOG.md",
      "LICENSE",
      "dist/cli/bin.js",
      "dist/cli/index.js",
      "fixtures/runtime-smoke-tasks.json",
      "src/cli/index.ts",
      "test/release-checklist.test.ts"
    ]);

    expect(result.ok).toBe(false);
    expect(result.details).toContain("forbidden");
  });
});

function createTempDir(prefix: string): string {
  const tempPath = mkdtempSync(join(tmpdir(), prefix));
  tempPaths.push(tempPath);
  return tempPath;
}
