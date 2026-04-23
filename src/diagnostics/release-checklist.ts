import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { runEvalReport } from "./eval.js";
import { runBetaReadinessCheck } from "./beta-readiness.js";
import type { SupportedProviderName } from "../providers/index.js";

export interface ReleaseChecklistItem {
  id: string;
  ok: boolean;
  title: string;
  details: string;
}

export interface ReleaseChecklistReport {
  allPassed: boolean;
  generatedAt: string;
  items: ReleaseChecklistItem[];
}

export interface ReleaseChecklistOptions {
  cwd?: string;
  provider?: SupportedProviderName | "scripted-smoke";
}

export async function runReleaseChecklist(
  options: ReleaseChecklistOptions = {}
): Promise<ReleaseChecklistReport> {
  const cwd = options.cwd ?? process.cwd();
  const repository = validateReleaseRepository(cwd);
  if (!repository.ok) {
    return {
      allPassed: false,
      generatedAt: new Date().toISOString(),
      items: [toItem("release-repository", "Release check runs inside the auto-talon repository", false, repository.details)]
    };
  }

  const provider = options.provider ?? "scripted-smoke";
  const evalReport = await runEvalReport({ providerName: provider });
  const beta = await runBetaReadinessCheck({ providerName: provider });
  const schemaVersion = readSchemaVersion(cwd);

  const lint = runCommand("corepack", ["pnpm", "lint"], cwd);
  const test = runCommand("corepack", ["pnpm", "test"], cwd);
  const build = runCommand("corepack", ["pnpm", "build"], cwd);
  const packageMetadata = validatePackageMetadata(cwd);
  const lockfiles = validateLockfilePolicy(cwd);
  const pack = runPackDryRun(cwd);
  const packContents = pack.ok
    ? validatePackContents(pack.files)
    : { ok: false, details: pack.details };

  const items: ReleaseChecklistItem[] = [
    toItem("release-repository", "Release check runs inside the auto-talon repository", true, repository.details),
    toItem("lint", "Lint passes", lint.ok, lint.details),
    toItem("test", "All tests pass", test.ok, test.details),
    toItem("build", "Build succeeds", build.ok, build.details),
    toItem(
      "smoke",
      "Smoke/eval reaches threshold",
      evalReport.successRate >= 0.8,
      `successRate=${(evalReport.successRate * 100).toFixed(1)}%`
    ),
    toItem("beta", "Approval/provider/gateway readiness checks pass", beta.allPassed, `${beta.checklist.length} checks`),
    toItem("doctor", "Config doctor can run", true, "covered by beta readiness doctor/provider checks"),
    toItem("schema", "Schema version matches v0.1.0 baseline", schemaVersion === 2, `user_version=${schemaVersion}`),
    toItem(
      "compat-matrix",
      "Compatibility matrix document exists",
      existsSync(join(cwd, "docs", "compatibility-matrix.md")),
      "docs/compatibility-matrix.md"
    ),
    toItem(
      "workspace",
      "Workspace setup scripts exist",
      existsSync(join(cwd, "scripts", "setup.sh")) && existsSync(join(cwd, "scripts", "setup.ps1")),
      "scripts/setup.sh and scripts/setup.ps1"
    ),
    toItem("lockfiles", "pnpm is the only repository lockfile", lockfiles.ok, lockfiles.details),
    toItem("package-metadata", "Public npm package metadata is complete", packageMetadata.ok, packageMetadata.details),
    toItem("pack-contents", "npm package includes only release assets", packContents.ok, packContents.details)
  ];

  return {
    allPassed: items.every((item) => item.ok),
    generatedAt: new Date().toISOString(),
    items
  };
}

function toItem(id: string, title: string, ok: boolean, details: string): ReleaseChecklistItem {
  return { id, title, ok, details };
}

function runCommand(command: string, args: string[], cwd: string): { details: string; ok: boolean } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32"
  });
  if (result.status === 0) {
    return { ok: true, details: `${command} ${args.join(" ")}` };
  }
  const error = result.stderr?.trim() || result.stdout?.trim() || "unknown failure";
  return { ok: false, details: error.split("\n")[0] ?? "failed" };
}

export function validateReleaseRepository(cwd: string): { details: string; ok: boolean } {
  const packageJson = readPackageJson(cwd);
  if (packageJson === null) {
    return {
      details: "package.json was not found",
      ok: false
    };
  }

  const expectedFiles = [
    "src/cli/index.ts",
    "src/diagnostics/release-checklist.ts",
    "fixtures/runtime-smoke-tasks.json"
  ];
  const missingFiles = expectedFiles.filter((path) => !existsSync(join(cwd, path)));
  if (packageJson.name !== "auto-talon" || missingFiles.length > 0) {
    return {
      details: `release check is maintainer-only; run it from the auto-talon repository root${missingFiles.length > 0 ? ` (missing ${missingFiles.join(", ")})` : ""}`,
      ok: false
    };
  }

  return {
    details: "auto-talon repository root",
    ok: true
  };
}

export function validatePackageMetadata(cwd: string): { details: string; ok: boolean } {
  const packageJson = readPackageJson(cwd);
  if (packageJson === null) {
    return { details: "package.json was not found", ok: false };
  }

  const missing: string[] = [];
  if (packageJson.private === true) {
    missing.push("private=false");
  }
  for (const key of ["license", "repository", "bugs", "homepage", "main", "types", "files"] as const) {
    if (packageJson[key] === undefined) {
      missing.push(key);
    }
  }
  if (!hasBinTalon(packageJson)) {
    missing.push("bin.talon");
  }

  return {
    details: missing.length === 0 ? "public npm metadata present" : `missing or invalid: ${missing.join(", ")}`,
    ok: missing.length === 0
  };
}

export function validateLockfilePolicy(cwd: string): { details: string; ok: boolean } {
  const hasPnpmLock = existsSync(join(cwd, "pnpm-lock.yaml"));
  const hasPackageLock = existsSync(join(cwd, "package-lock.json"));
  const issues = [
    ...(!hasPnpmLock ? ["missing pnpm-lock.yaml"] : []),
    ...(hasPackageLock ? ["package-lock.json is not allowed"] : [])
  ];

  return {
    details: issues.length === 0 ? "pnpm-lock.yaml is the only lockfile" : issues.join("; "),
    ok: issues.length === 0
  };
}

export function validatePackContents(files: string[]): { details: string; ok: boolean } {
  const requiredFiles = [
    "dist/cli/bin.js",
    "dist/cli/index.js",
    "fixtures/runtime-smoke-tasks.json",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
    "package.json"
  ];
  const missingRequired = requiredFiles.filter((path) => !files.includes(path));
  const forbidden = files.filter((path) =>
    path.startsWith("src/") ||
    path.startsWith("test/") ||
    path.startsWith(".github/") ||
    path === "eslint.config.js" ||
    path === "tsconfig.json" ||
    path === "tsconfig.eslint.json" ||
    path === "vitest.config.ts" ||
    path === "package-lock.json" ||
    path === "pnpm-lock.yaml"
  );

  const issues = [
    ...(missingRequired.length > 0 ? [`missing ${missingRequired.join(", ")}`] : []),
    ...(forbidden.length > 0 ? [`forbidden ${forbidden.slice(0, 8).join(", ")}${forbidden.length > 8 ? ", ..." : ""}`] : [])
  ];

  return {
    details: issues.length === 0 ? `${files.length} release files` : issues.join("; "),
    ok: issues.length === 0
  };
}

function runPackDryRun(cwd: string): { details: string; files: string[]; ok: boolean } {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32"
  });
  if (result.status !== 0) {
    const error = result.stderr?.trim() || result.stdout?.trim() || "unknown failure";
    return { details: error.split("\n")[0] ?? "npm pack failed", files: [], ok: false };
  }

  try {
    const parsed = JSON.parse(result.stdout) as Array<{
      entryCount?: number;
      files?: Array<{ path?: unknown }>;
    }>;
    const first = parsed[0];
    const files = first?.files
      ?.map((file) => file.path)
      .filter((path): path is string => typeof path === "string") ?? [];
    return {
      details: `${first?.entryCount ?? files.length} files`,
      files,
      ok: files.length > 0
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { details: `failed to parse npm pack output: ${message}`, files: [], ok: false };
  }
}

function readPackageJson(cwd: string): Record<string, unknown> | null {
  const packageJsonPath = join(cwd, "package.json");
  if (!existsSync(packageJsonPath)) {
    return null;
  }

  return JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
}

function hasBinTalon(packageJson: Record<string, unknown>): boolean {
  const bin = packageJson.bin;
  return (
    typeof bin === "object" &&
    bin !== null &&
    (bin as Record<string, unknown>).talon === "dist/cli/bin.js"
  );
}

function readSchemaVersion(cwd: string): number {
  try {
    const dbPath = join(cwd, ".auto-talon", "agent-runtime.db");
    if (!existsSync(dbPath)) {
      return 0;
    }
    const db = new DatabaseSync(dbPath);
    const row = db.prepare("PRAGMA user_version").get() as { user_version?: number };
    db.close();
    return row.user_version ?? 0;
  } catch {
    return -1;
  }
}
