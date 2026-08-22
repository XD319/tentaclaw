import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { extname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { runEvalReport } from "./eval.js";
import { runBetaReadinessCheck } from "./beta-readiness.js";
import { runCapabilityEval } from "../evaluation/public.js";
import type { SupportedProviderName } from "../providers/index.js";
import { RUNTIME_SCHEMA_VERSION, runMigrations } from "../storage/migrations.js";
import { configureSqliteConnection } from "../storage/sqlite-connection.js";

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
  commandTimeoutMs?: number;
  cwd?: string;
  onProgress?: (message: string) => void;
  provider?: SupportedProviderName | "scripted-smoke";
  skipQualityChecks?: boolean;
}

export async function runReleaseChecklist(
  options: ReleaseChecklistOptions = {}
): Promise<ReleaseChecklistReport> {
  const cwd = options.cwd ?? process.cwd();
  const commandTimeoutMs = options.commandTimeoutMs ?? 10 * 60 * 1000;
  const progress = options.onProgress ?? (() => undefined);
  progress("Validating release repository");
  const repository = validateReleaseRepository(cwd);
  if (!repository.ok) {
    return {
      allPassed: false,
      generatedAt: new Date().toISOString(),
      items: [toItem("release-repository", "Release check runs inside the auto-talon repository", false, repository.details)]
    };
  }

  const provider = options.provider ?? "scripted-smoke";
  progress(`Running smoke/eval checks with ${provider}`);
  const evalReport = await runEvalReport({ providerName: provider });
  progress("Running beta readiness checks");
  const beta = await runBetaReadinessCheck({ providerName: provider });
  progress("Running reliability acceptance gate");
  const acceptance = await runReliabilityAcceptanceGate(provider, cwd);
  const schema = validateMigrationSchemaVersion();

  const skippedQualityCheck = {
    details: "skipped by --skip-quality-checks; run corepack pnpm check separately",
    ok: true
  };
  progress(options.skipQualityChecks === true ? "Skipping lint, test, and build" : "Running lint");
  const lint = options.skipQualityChecks === true
    ? skippedQualityCheck
    : runPackageScript("lint", cwd, commandTimeoutMs);
  if (options.skipQualityChecks !== true) {
    progress("Running full test suite (this can take several minutes)");
  }
  const test = options.skipQualityChecks === true
    ? skippedQualityCheck
    : runPackageScript("test", cwd, commandTimeoutMs);
  if (options.skipQualityChecks !== true) {
    progress("Building release artifacts");
  }
  const build = options.skipQualityChecks === true
    ? skippedQualityCheck
    : runPackageScript("build", cwd, commandTimeoutMs);
  const packageMetadata = validatePackageMetadata(cwd);
  const nodeVersion = validateNodeVersionPolicy(cwd);
  const lockfiles = validateLockfilePolicy(cwd);
  progress("Inspecting npm package contents");
  const pack = runPackDryRun(cwd, commandTimeoutMs);
  const packContents = pack.ok
    ? validatePackContents(pack.files)
    : { ok: false, details: pack.details };
  const packagedTextEncoding = pack.ok
    ? validatePackagedTextEncoding(cwd, pack.files)
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
    toItem("reliability-acceptance", "Reliability acceptance suite passes verification/scope gate", acceptance.ok, acceptance.details),
    toItem("doctor", "Config doctor can run", true, "covered by beta readiness doctor/provider checks"),
    toItem(
      "schema",
      "Schema version matches current runtime baseline",
      schema.ok,
      schema.details
    ),
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
    toItem("node-version", "Node.js minimum version is consistent", nodeVersion.ok, nodeVersion.details),
    toItem("lockfiles", "pnpm is the only repository lockfile", lockfiles.ok, lockfiles.details),
    toItem("package-metadata", "Public npm package metadata is complete", packageMetadata.ok, packageMetadata.details),
    toItem("pack-contents", "npm package includes only release assets", packContents.ok, packContents.details),
    toItem(
      "packaged-text-encoding",
      "Packaged text has no mojibake residue",
      packagedTextEncoding.ok,
      packagedTextEncoding.details
    )
  ];
  progress("Release checklist complete");

  return {
    allPassed: items.every((item) => item.ok),
    generatedAt: new Date().toISOString(),
    items
  };
}

function toItem(id: string, title: string, ok: boolean, details: string): ReleaseChecklistItem {
  return { id, title, ok, details };
}

/**
 * Runs the reliability acceptance suite with verification/scope gate thresholds.
 * Requires a real provider; scripted-smoke/mock runs are skipped (reported ok)
 * because the capability eval refuses non-real providers by design.
 */
async function runReliabilityAcceptanceGate(
  provider: SupportedProviderName | "scripted-smoke",
  cwd: string
): Promise<{ details: string; ok: boolean }> {
  if (provider === "scripted-smoke") {
    return {
      details: "skipped: run `talon eval acceptance --provider <real-provider>` for a real-model gate",
      ok: true
    };
  }
  try {
    const report = await runCapabilityEval({
      configCwd: cwd,
      gateThresholds: { maxWorkspaceScopeViolationRate: 0.1, minVerificationCompletionRate: 0.5 },
      providerName: provider,
      repetitions: 1,
      suitePath: join(cwd, "fixtures", "eval-suites", "reliability-acceptance.v1.json")
    });
    return {
      details: report.gate.passed
        ? `success=${(report.metrics.successRate * 100).toFixed(1)}%, verification=${report.metrics.verificationCompletionRate === null || report.metrics.verificationCompletionRate === undefined ? "n/a" : `${(report.metrics.verificationCompletionRate * 100).toFixed(1)}%`}`
        : report.gate.reasons.join("; "),
      ok: report.gate.passed
    };
  } catch (error) {
    return {
      details: `acceptance run failed: ${error instanceof Error ? error.message : String(error)}`,
      ok: false
    };
  }
}

type ReleasePackageScript = "build" | "lint" | "test";

export function runPackageScript(
  script: ReleasePackageScript,
  cwd: string,
  timeoutMs = 10 * 60 * 1000
): { details: string; ok: boolean } {
  return runCommand("npm", ["run", script], cwd, timeoutMs);
}

function runCommand(command: string, args: string[], cwd: string, timeoutMs: number): { details: string; ok: boolean } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: timeoutMs
  });
  if (result.status === 0) {
    return { ok: true, details: `${command} ${args.join(" ")}` };
  }
  const timedOut = result.error !== undefined && "code" in result.error && result.error.code === "ETIMEDOUT";
  if (timedOut) {
    return { ok: false, details: `${command} ${args.join(" ")} timed out after ${timeoutMs}ms` };
  }
  const error = result.stderr?.trim() || result.stdout?.trim() || result.error?.message || "unknown failure";
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
  if (!hasPublicPublishConfig(packageJson)) {
    missing.push("publishConfig.access=public");
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

export function validateNodeVersionPolicy(cwd: string): { details: string; ok: boolean } {
  const expectedVersion = "22.13.0";
  const expectedRange = `>=${expectedVersion}`;
  const packageJson = readPackageJson(cwd);
  const issues: string[] = [];

  const engines = packageJson?.engines;
  const nodeRange = typeof engines === "object" && engines !== null
    ? (engines as Record<string, unknown>).node
    : undefined;
  if (nodeRange !== expectedRange) {
    issues.push(`package.json engines.node must be ${expectedRange}`);
  }

  const files = [
    "src/cli/bin.ts",
    "scripts/setup.sh",
    "scripts/setup.ps1"
  ];
  for (const file of files) {
    const path = join(cwd, file);
    if (!existsSync(path)) {
      issues.push(`${file} was not found`);
      continue;
    }
    const contents = readFileSync(path, "utf8");
    if (!contents.includes(expectedVersion)) {
      issues.push(`${file} must reference ${expectedVersion}`);
    }
  }

  return {
    details: issues.length === 0 ? `Node.js ${expectedRange} policy is consistent` : issues.join("; "),
    ok: issues.length === 0
  };
}

export function validatePackContents(files: string[]): { details: string; ok: boolean } {
  const requiredFiles = [
    "dist/cli/bin.js",
    "dist/cli/index.js",
    "README.md",
    "README.zh-CN.md",
    "SECURITY.md",
    "CHANGELOG.md",
    "LICENSE",
    "package.json"
  ];
  const missingRequired = requiredFiles.filter((path) => !files.includes(path));
  const forbidden = files.filter((path) =>
    path.startsWith("src/") ||
    path.startsWith("test/") ||
    path.startsWith("fixtures/") ||
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

export function validatePackagedTextEncoding(cwd: string, files: string[]): { details: string; ok: boolean } {
  const findings: string[] = [];
  let scannedCount = 0;

  for (const file of files) {
    if (!isScannableReleaseTextFile(file)) {
      continue;
    }
    const filePath = join(cwd, file);
    if (!existsSync(filePath)) {
      findings.push(`${file}: missing package text file`);
      continue;
    }
    scannedCount += 1;
    const contents = readFileSync(filePath, "utf8");
    const residue = findEncodingResidue(contents);
    if (residue !== null) {
      findings.push(`${file}:${residue.line}:${residue.column} ${residue.label}`);
    }
  }

  if (findings.length === 0) {
    return {
      details: `${scannedCount} packaged text files scanned`,
      ok: true
    };
  }

  const preview = findings.slice(0, 8).join("; ");
  return {
    details: `encoding residue found: ${preview}${findings.length > 8 ? "; ..." : ""}`,
    ok: false
  };
}

const releaseTextExtensions = new Set([
  ".css",
  ".cjs",
  ".html",
  ".js",
  ".jsx",
  ".json",
  ".map",
  ".md",
  ".mjs",
  ".ps1",
  ".sh",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml"
]);

const releaseTextFilenames = new Set([
  "changelog",
  "license",
  "notice",
  "readme",
  "security"
]);

const encodingResidueRules = [
  { label: "unicode replacement character", token: String.fromCharCode(0xfffd) },
  { label: "CJK mojibake marker", token: String.fromCharCode(0x9225) },
  { label: "CJK replacement mojibake marker", token: String.fromCharCode(0x951f) },
  { label: "Windows-1252 punctuation mojibake marker", token: String.fromCharCode(0x00e2, 0x20ac) },
  { label: "Latin-1 mojibake marker", token: String.fromCharCode(0x00c2) },
  { label: "Latin-1 mojibake marker", token: String.fromCharCode(0x00c3) }
] as const;

function isScannableReleaseTextFile(path: string): boolean {
  const normalized = path.replace(/\\/gu, "/");
  const filename = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  const extension = extname(filename);
  if (releaseTextExtensions.has(extension)) {
    return true;
  }
  return releaseTextFilenames.has(filename);
}

function findEncodingResidue(contents: string): { column: number; label: string; line: number } | null {
  let firstMatch: { index: number; label: string } | null = null;
  for (const rule of encodingResidueRules) {
    const index = contents.indexOf(rule.token);
    if (index < 0) {
      continue;
    }
    if (firstMatch === null || index < firstMatch.index) {
      firstMatch = { index, label: rule.label };
    }
  }
  if (firstMatch === null) {
    return null;
  }

  const location = locateTextIndex(contents, firstMatch.index);
  return {
    ...location,
    label: firstMatch.label
  };
}

function locateTextIndex(contents: string, index: number): { column: number; line: number } {
  let line = 1;
  let column = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (contents.charCodeAt(cursor) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { column, line };
}

function runPackDryRun(cwd: string, timeoutMs: number): { details: string; files: string[]; ok: boolean } {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: timeoutMs
  });
  const timedOut = result.error !== undefined && "code" in result.error && result.error.code === "ETIMEDOUT";
  if (timedOut) {
    return { details: `npm pack timed out after ${timeoutMs}ms`, files: [], ok: false };
  }
  if (result.status !== 0) {
    const error = result.stderr?.trim() || result.stdout?.trim() || "unknown failure";
    return { details: error.split("\n")[0] ?? "npm pack failed", files: [], ok: false };
  }

  try {
    const parsed = JSON.parse(extractPackJson(result.stdout)) as Array<{
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

export function validateMigrationSchemaVersion(): { details: string; ok: boolean } {
  const db = new DatabaseSync(":memory:");
  configureSqliteConnection(db);
  try {
    runMigrations(db);
    const row = db.prepare("PRAGMA user_version").get() as { user_version?: number };
    const schemaVersion = row.user_version ?? 0;
    return {
      details: `user_version=${schemaVersion}, expected=${RUNTIME_SCHEMA_VERSION}`,
      ok: schemaVersion === RUNTIME_SCHEMA_VERSION
    };
  } finally {
    db.close();
  }
}

function extractPackJson(output: string): string {
  const trimmed = output.trim();
  const start = trimmed.lastIndexOf("\n[");
  if (start >= 0) {
    return trimmed.slice(start + 1);
  }
  const directStart = trimmed.indexOf("[");
  if (directStart >= 0) {
    return trimmed.slice(directStart);
  }
  return trimmed;
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

function hasPublicPublishConfig(packageJson: Record<string, unknown>): boolean {
  const publishConfig = packageJson.publishConfig;
  return (
    typeof publishConfig === "object" &&
    publishConfig !== null &&
    (publishConfig as Record<string, unknown>).access === "public"
  );
}
