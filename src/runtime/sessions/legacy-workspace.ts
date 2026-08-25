import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { DatabaseSync } from "node:sqlite";

import { AppError } from "../../core/app-error.js";
import { collectLegacySchemaIssues } from "../../storage/migrations.js";

export function listPendingJsonTranscriptFiles(workspaceRoot: string): string[] {
  const sessionsDir = join(workspaceRoot, ".auto-talon", "sessions");
  if (!existsSync(sessionsDir)) {
    return [];
  }
  return readdirSync(sessionsDir).filter(
    (entry) => entry.endsWith(".json") && !entry.endsWith(".json.migrated")
  );
}

export function collectLegacyWorkspaceIssues(
  workspaceRoot: string,
  database: DatabaseSync
): string[] {
  const issues = collectLegacySchemaIssues(database);
  for (const fileName of listPendingJsonTranscriptFiles(workspaceRoot)) {
    issues.push(`Legacy JSON session transcript pending migration: .auto-talon/sessions/${fileName}`);
  }
  return issues;
}

export function isLegacyMigrationIssue(issue: string): boolean {
  return (
    issue.startsWith("Legacy table still present:") ||
    issue.startsWith("Legacy column still present:") ||
    issue.startsWith("Legacy JSON session transcript pending migration:")
  );
}

export function formatLegacyMigrationGuidance(issues: string[]): string {
  if (issues.length === 0) {
    return "No legacy workspace migration issues detected.";
  }

  return [
    "Legacy workspace migration required.",
    "",
    "Current state:",
    ...issues.map((issue) => `- ${issue}`),
    "",
    "Impact: talon tui, talon run, talon continue, and other workspace commands stay blocked until this one-time migration finishes.",
    "",
    "Fix (run in the workspace root):",
    "  talon doctor --fix",
    "Then verify:",
    "  talon doctor",
    "From a source checkout use: corepack pnpm dev doctor --fix"
  ].join("\n");
}

export function assertLegacyWorkspaceMigrated(
  workspaceRoot: string,
  database: DatabaseSync
): void {
  const issues = collectLegacyWorkspaceIssues(workspaceRoot, database);
  if (issues.length === 0) {
    return;
  }
  throw new AppError({
    code: "invalid_state",
    message: formatLegacyMigrationGuidance(issues)
  });
}
