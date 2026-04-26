import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { runMigrations } from "../src/storage/migrations.js";
import { SqliteMemoryRepository } from "../src/storage/repositories/memory-repository.js";

describe("memory scope migration", () => {
  it("renames legacy agent/session retention kinds to layered names", () => {
    const workspace = mkdtempSync(join(tmpdir(), "auto-talon-memory-migration-"));
    const databasePath = join(workspace, "runtime.db");
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(`
        CREATE TABLE memories (
          memory_id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          scope_key TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          summary TEXT NOT NULL,
          source_json TEXT NOT NULL,
          source_type TEXT NOT NULL,
          privacy_level TEXT NOT NULL,
          retention_policy_json TEXT NOT NULL,
          confidence REAL NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_verified_at TEXT,
          expires_at TEXT,
          supersedes TEXT,
          conflicts_with_json TEXT NOT NULL,
          keywords_json TEXT NOT NULL,
          metadata_json TEXT NOT NULL
        );
        PRAGMA user_version = 7;
      `);
      db.prepare(
        `INSERT INTO memories (
          memory_id, scope, scope_key, title, content, summary, source_json, source_type,
          privacy_level, retention_policy_json, confidence, status, created_at, updated_at,
          last_verified_at, expires_at, supersedes, conflicts_with_json, keywords_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "mem-legacy-1",
        "agent",
        "u:p",
        "Legacy agent memory",
        "content",
        "summary",
        JSON.stringify({ label: "legacy", sourceType: "manual_review", taskId: null, toolCallId: null, traceEventId: null }),
        "manual_review",
        "internal",
        JSON.stringify({ kind: "agent", reason: "legacy", ttlDays: 30 }),
        0.9,
        "verified",
        new Date().toISOString(),
        new Date().toISOString(),
        null,
        null,
        null,
        JSON.stringify([]),
        JSON.stringify(["legacy"]),
        JSON.stringify({})
      );

      runMigrations(db);

      const repository = new SqliteMemoryRepository(db);
      const migrated = repository.findById("mem-legacy-1");
      expect(migrated?.scope).toBe("profile");
      expect(migrated?.retentionPolicy.kind).toBe("profile");
      const userVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };
      expect(userVersion.user_version).toBe(10);
    } finally {
      db.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });
});
