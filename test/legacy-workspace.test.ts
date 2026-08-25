import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { formatDoctorReport } from "../src/cli/formatters.js";
import { AppError } from "../src/core/app-error.js";
import {
  assertLegacyWorkspaceMigrated,
  collectLegacyWorkspaceIssues,
  formatLegacyMigrationGuidance,
  isLegacyMigrationIssue
} from "../src/runtime/sessions/legacy-workspace.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined) {
      rmSync(tempPath, { force: true, recursive: true });
    }
  }
});

describe("legacy workspace migration guidance", () => {
  it("formats current state, impact, and exact fix command", () => {
    const guidance = formatLegacyMigrationGuidance([
      "Legacy table still present: threads",
      "Legacy JSON session transcript pending migration: .auto-talon/sessions/old.json"
    ]);

    expect(guidance).toContain("Legacy workspace migration required.");
    expect(guidance).toContain("Current state:");
    expect(guidance).toContain("- Legacy table still present: threads");
    expect(guidance).toContain("Impact:");
    expect(guidance).toContain("talon doctor --fix");
    expect(guidance).toContain("talon doctor");
  });

  it("detects legacy migration issue prefixes", () => {
    expect(isLegacyMigrationIssue("Legacy table still present: threads")).toBe(true);
    expect(isLegacyMigrationIssue("Legacy column still present: tasks.thread_id")).toBe(true);
    expect(
      isLegacyMigrationIssue(
        "Legacy JSON session transcript pending migration: .auto-talon/sessions/a.json"
      )
    ).toBe(true);
    expect(isLegacyMigrationIssue("ripgrep (rg) is not on PATH")).toBe(false);
  });

  it("collects schema and pending JSON transcript issues without crashing", () => {
    const workspaceRoot = createTempDir("talon-legacy-guidance-");
    mkdirSync(join(workspaceRoot, ".auto-talon", "sessions"), { recursive: true });
    writeFileSync(join(workspaceRoot, ".auto-talon", "sessions", "legacy.json"), "{}", "utf8");
    writeFileSync(
      join(workspaceRoot, ".auto-talon", "sessions", "done.json.migrated"),
      "{}",
      "utf8"
    );

    const database = new DatabaseSync(":memory:");
    database.exec("CREATE TABLE threads (thread_id TEXT PRIMARY KEY)");
    database.exec("CREATE TABLE tasks (task_id TEXT PRIMARY KEY, thread_id TEXT)");

    const issues = collectLegacyWorkspaceIssues(workspaceRoot, database);
    expect(issues).toEqual(
      expect.arrayContaining([
        "Legacy table still present: threads",
        "Legacy column still present: tasks.thread_id",
        "Legacy JSON session transcript pending migration: .auto-talon/sessions/legacy.json"
      ])
    );
    expect(issues.some((issue) => issue.includes("done.json.migrated"))).toBe(false);

    expect(() => assertLegacyWorkspaceMigrated(workspaceRoot, database)).toThrow(AppError);
    try {
      assertLegacyWorkspaceMigrated(workspaceRoot, database);
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).message).toContain("talon doctor --fix");
      expect((error as AppError).message).toContain("Current state:");
    }
  });

  it("allows already-migrated workspaces", () => {
    const workspaceRoot = createTempDir("talon-legacy-clean-");
    mkdirSync(join(workspaceRoot, ".auto-talon", "sessions"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, ".auto-talon", "sessions", "done.json.migrated"),
      "{}",
      "utf8"
    );
    const database = new DatabaseSync(":memory:");
    expect(collectLegacyWorkspaceIssues(workspaceRoot, database)).toEqual([]);
    expect(() => assertLegacyWorkspaceMigrated(workspaceRoot, database)).not.toThrow();
  });

  it("surfaces migration guidance inside doctor report formatting", () => {
    const output = formatDoctorReport({
      allowedFetchHosts: [],
      apiKeyConfigured: true,
      configFiles: [],
      configPath: "/tmp/provider.config.json",
      configSource: "user",
      corepackAvailable: true,
      databasePath: "/tmp/agent.sqlite",
      databaseReachable: true,
      distFresh: true,
      endpointReachable: true,
      experienceStats: {
        accepted: 0,
        candidate: 0,
        promoted: 0,
        rejected: 0,
        stale: 0,
        total: 0
      },
      issues: [
        "ripgrep (rg) is not on PATH",
        "Legacy table still present: threads"
      ],
      maxRetries: 2,
      modelAvailable: true,
      modelConfigured: true,
      modelName: "mock",
      nodeVersion: "v22.13.0",
      pnpmVersion: "9.0.0",
      providerHealthMessage: "ok",
      providerName: "mock",
      runtimeConfigPath: "/tmp/runtime.config.json",
      runtimeConfigSource: "defaults",
      runtimeVersion: "0.1.1",
      schemaVersion: 26,
      shell: "powershell",
      shellBackend: "default",
      shellBackendAvailable: true,
      shellExecutable: "powershell",
      shellMaxTimeoutMs: 120_000,
      skillStats: { enabled: 0, issues: 0, total: 0 },
      streamIdleTimeoutMs: 120_000,
      timeoutMs: 120_000,
      tokenBudget: { inputLimit: 32_000, outputLimit: 4_000, reservedOutput: 1_000 },
      workspaceRoot: "/tmp/workspace",
      workspaceSecretFindings: []
    });

    expect(output).toContain("ripgrep (rg) is not on PATH");
    expect(output).toContain("Legacy workspace migration required.");
    expect(output).toContain("talon doctor --fix");
  });
});

function createTempDir(prefix: string): string {
  const tempPath = mkdtempSync(join(tmpdir(), prefix));
  tempPaths.push(tempPath);
  return tempPath;
}
