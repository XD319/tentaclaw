import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { RUNTIME_SCHEMA_VERSION, runMigrations } from "../src/storage/migrations.js";
import { StorageManager } from "../src/storage/database.js";
import { SqliteMemoryRepository } from "../src/storage/repositories/memory-repository.js";

describe("storage migrations", () => {
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
      expect(userVersion.user_version).toBe(RUNTIME_SCHEMA_VERSION);
    } finally {
      db.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("repairs missing session core tables in high-version databases", () => {
    const workspace = mkdtempSync(join(tmpdir(), "auto-talon-session-migration-"));
    const databasePath = join(workspace, "runtime.db");
    const db = new DatabaseSync(databasePath);
    try {
      db.exec("PRAGMA user_version = 16;");

      runMigrations(db);

      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
        .get() as { name?: string } | undefined;
      expect(table?.name).toBe("sessions");
      const userVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };
      expect(userVersion.user_version).toBe(RUNTIME_SCHEMA_VERSION);
    } finally {
      db.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("migrates legacy thread_id columns through schema version 22", () => {
    const workspace = mkdtempSync(join(tmpdir(), "auto-talon-session-repair-"));
    const databasePath = join(workspace, "runtime.db");
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(`
        CREATE TABLE tasks (
          task_id TEXT PRIMARY KEY,
          input TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          cwd TEXT NOT NULL DEFAULT '/tmp',
          provider_name TEXT NOT NULL DEFAULT 'mock',
          agent_profile_id TEXT NOT NULL DEFAULT 'executor',
          requester_user_id TEXT NOT NULL DEFAULT 'local-user',
          current_iteration INTEGER NOT NULL DEFAULT 0,
          max_iterations INTEGER NOT NULL DEFAULT 10,
          created_at TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL DEFAULT '',
          started_at TEXT,
          finished_at TEXT,
          final_output TEXT,
          error_code TEXT,
          error_message TEXT,
          token_budget_json TEXT NOT NULL DEFAULT '{}',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          thread_id TEXT
        );
        INSERT INTO tasks (task_id, input, thread_id) VALUES ('task-legacy', 'legacy input', 'thread-legacy');
        PRAGMA user_version = 21;
      `);

      runMigrations(db);

      expect(
        (db.prepare("SELECT session_id FROM tasks WHERE task_id = 'task-legacy'").get() as { session_id: string })
          .session_id
      ).toBe("thread-legacy");
      expect(() =>
        db
          .prepare(
            `INSERT INTO tasks (
              task_id, session_id, input, status, cwd, provider_name, agent_profile_id,
              requester_user_id, current_iteration, max_iterations, created_at, updated_at,
              token_budget_json, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            "task-new",
            "session-new",
            "hello",
            "pending",
            "/tmp",
            "mock",
            "executor",
            "local-user",
            0,
            10,
            "2026-01-01T00:00:00.000Z",
            "2026-01-01T00:00:00.000Z",
            "{}",
            "{}"
          )
      ).not.toThrow();
    } finally {
      db.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("drops legacy thread_id columns so commitments accept session_id inserts", () => {
    const workspace = mkdtempSync(join(tmpdir(), "auto-talon-commitments-thread-migration-"));
    const databasePath = join(workspace, "runtime.db");
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(`
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          owner_user_id TEXT NOT NULL,
          cwd TEXT NOT NULL,
          agent_profile_id TEXT NOT NULL,
          provider_name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT,
          metadata_json TEXT NOT NULL
        );
        CREATE TABLE commitments (
          commitment_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          task_id TEXT,
          owner_user_id TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          status TEXT NOT NULL,
          blocked_reason TEXT,
          pending_decision TEXT,
          source TEXT NOT NULL,
          source_trace_id TEXT,
          due_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          metadata_json TEXT NOT NULL
        );
        INSERT INTO sessions (
          session_id, title, status, owner_user_id, cwd, agent_profile_id, provider_name,
          created_at, updated_at, archived_at, metadata_json
        ) VALUES (
          'session-1', 'Legacy session', 'active', 'u1', '/tmp', 'executor', 'mock',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, '{}'
        );
        PRAGMA user_version = 21;
      `);

      runMigrations(db);

      const columns = (db.prepare("PRAGMA table_info(commitments)").all() as Array<{ name: string }>).map(
        (column) => column.name
      );
      expect(columns).toContain("session_id");
      expect(columns).not.toContain("thread_id");

      const storage = new StorageManager({ databasePath });
      try {
        expect(() =>
          storage.commitments.create({
            ownerUserId: "u1",
            sessionId: "session-1",
            source: "manual",
            summary: "summary",
            title: "Ship feature"
          })
        ).not.toThrow();
      } finally {
        storage.close();
      }
    } finally {
      db.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("repairs legacy schema without foreign key failures", () => {
    const workspace = mkdtempSync(join(tmpdir(), "auto-talon-fk-repair-"));
    const databasePath = join(workspace, "runtime.db");
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(`
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          owner_user_id TEXT NOT NULL,
          cwd TEXT NOT NULL,
          agent_profile_id TEXT NOT NULL,
          provider_name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT,
          metadata_json TEXT NOT NULL
        );
        CREATE TABLE commitments (
          commitment_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          session_id TEXT,
          task_id TEXT,
          owner_user_id TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          status TEXT NOT NULL,
          blocked_reason TEXT,
          pending_decision TEXT,
          source TEXT NOT NULL,
          source_trace_id TEXT,
          due_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          metadata_json TEXT NOT NULL
        );
        CREATE TABLE next_actions (
          next_action_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          session_id TEXT,
          commitment_id TEXT REFERENCES commitments(commitment_id),
          task_id TEXT,
          title TEXT NOT NULL,
          detail TEXT,
          status TEXT NOT NULL,
          rank INTEGER NOT NULL DEFAULT 0,
          blocked_reason TEXT,
          source TEXT NOT NULL,
          source_trace_id TEXT,
          due_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          metadata_json TEXT NOT NULL
        );
        INSERT INTO commitments (
          commitment_id, thread_id, session_id, owner_user_id, title, summary, status, source,
          created_at, updated_at, metadata_json
        ) VALUES (
          'commitment-1', 'session-orphan', 'session-orphan', 'u1', 'Legacy commitment', 'summary', 'open', 'manual',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{}'
        );
        INSERT INTO next_actions (
          next_action_id, thread_id, session_id, commitment_id, title, status, rank, source,
          created_at, updated_at, metadata_json
        ) VALUES (
          'action-1', 'session-orphan', 'session-orphan', 'commitment-1', 'Follow up', 'active', 0, 'manual',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{}'
        );
        PRAGMA user_version = 21;
      `);

      expect(() => runMigrations(db)).not.toThrow();
      expect(
        (db.prepare("SELECT session_id FROM sessions WHERE session_id = 'session-orphan'").get() as { session_id: string })
          .session_id
      ).toBe("session-orphan");
    } finally {
      db.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("cleans up interrupted table migration temp tables", () => {
    const workspace = mkdtempSync(join(tmpdir(), "auto-talon-interrupted-migration-"));
    const databasePath = join(workspace, "runtime.db");
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(`
        CREATE TABLE tasks (
          task_id TEXT PRIMARY KEY,
          input TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          cwd TEXT NOT NULL DEFAULT '/tmp',
          provider_name TEXT NOT NULL DEFAULT 'mock',
          agent_profile_id TEXT NOT NULL DEFAULT 'executor',
          requester_user_id TEXT NOT NULL DEFAULT 'local-user',
          current_iteration INTEGER NOT NULL DEFAULT 0,
          max_iterations INTEGER NOT NULL DEFAULT 10,
          created_at TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL DEFAULT '',
          started_at TEXT,
          finished_at TEXT,
          final_output TEXT,
          error_code TEXT,
          error_message TEXT,
          token_budget_json TEXT NOT NULL DEFAULT '{}',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          session_id TEXT,
          thread_id TEXT
        );
        CREATE TABLE tasks__session_migration (
          task_id TEXT PRIMARY KEY,
          input TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          cwd TEXT NOT NULL DEFAULT '/tmp',
          provider_name TEXT NOT NULL DEFAULT 'mock',
          agent_profile_id TEXT NOT NULL DEFAULT 'executor',
          requester_user_id TEXT NOT NULL DEFAULT 'local-user',
          current_iteration INTEGER NOT NULL DEFAULT 0,
          max_iterations INTEGER NOT NULL DEFAULT 10,
          created_at TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL DEFAULT '',
          started_at TEXT,
          finished_at TEXT,
          final_output TEXT,
          error_code TEXT,
          error_message TEXT,
          token_budget_json TEXT NOT NULL DEFAULT '{}',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          session_id TEXT
        );
        INSERT INTO tasks (task_id, input, thread_id) VALUES ('task-1', 'legacy input', 'thread-1');
        PRAGMA user_version = 21;
      `);

      expect(() => runMigrations(db)).not.toThrow();
      expect(tableNames(db)).not.toContain("tasks__session_migration");
      const columns = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map(
        (column) => column.name
      );
      expect(columns).toContain("session_id");
      expect(columns).not.toContain("thread_id");
    } finally {
      db.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("backfills session ids from legacy thread columns", () => {
    const workspace = mkdtempSync(join(tmpdir(), "auto-talon-thread-session-migration-"));
    const databasePath = join(workspace, "runtime.db");
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(`
        CREATE TABLE tasks (
          task_id TEXT PRIMARY KEY,
          thread_id TEXT
        );
        CREATE TABLE commitments (
          commitment_id TEXT PRIMARY KEY,
          thread_id TEXT
        );
        CREATE TABLE output_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          task_id TEXT NOT NULL,
          thread_id TEXT,
          timestamp TEXT NOT NULL,
          event_type TEXT NOT NULL,
          stage TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE TABLE threads (
          thread_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          owner_user_id TEXT NOT NULL,
          cwd TEXT NOT NULL,
          agent_profile_id TEXT NOT NULL,
          provider_name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT,
          metadata_json TEXT NOT NULL
        );
        INSERT INTO tasks (task_id, thread_id) VALUES ('task-1', 'thread-1');
        INSERT INTO commitments (commitment_id, thread_id) VALUES ('commitment-1', 'thread-1');
        INSERT INTO output_events (
          event_id, task_id, thread_id, timestamp, event_type, stage, payload_json
        ) VALUES ('event-1', 'task-1', 'thread-1', '2026-01-01T00:00:00.000Z', 'status', 'running', '{}');
        INSERT INTO threads (
          thread_id, title, status, owner_user_id, cwd, agent_profile_id, provider_name,
          created_at, updated_at, archived_at, metadata_json
        ) VALUES (
          'thread-1', 'Legacy thread', 'active', 'u1', '/tmp/workspace', 'executor', 'mock',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, '{}'
        );
        PRAGMA user_version = 16;
      `);

      runMigrations(db);

      expect((db.prepare("SELECT session_id FROM tasks WHERE task_id = 'task-1'").get() as { session_id: string }).session_id).toBe("thread-1");
      expect(
        (db.prepare("SELECT session_id FROM commitments WHERE commitment_id = 'commitment-1'").get() as { session_id: string }).session_id
      ).toBe("thread-1");
      expect(
        (db.prepare("SELECT session_id FROM output_events WHERE event_id = 'event-1'").get() as { session_id: string }).session_id
      ).toBe("thread-1");
      expect((db.prepare("SELECT title FROM sessions WHERE session_id = 'thread-1'").get() as { title: string }).title).toBe("Legacy thread");
    } finally {
      db.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("cancels duplicate active schedule runs before creating the one-active index", () => {
    const workspace = mkdtempSync(join(tmpdir(), "auto-talon-schedule-run-migration-"));
    const databasePath = join(workspace, "runtime.db");
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(`
        CREATE TABLE schedules (
          schedule_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          session_id TEXT,
          owner_user_id TEXT NOT NULL,
          cwd TEXT NOT NULL,
          agent_profile_id TEXT NOT NULL,
          provider_name TEXT NOT NULL,
          input TEXT NOT NULL,
          cron TEXT,
          interval_ms INTEGER,
          run_at TEXT,
          timezone TEXT,
          next_fire_at TEXT,
          last_fire_at TEXT,
          max_attempts INTEGER NOT NULL,
          backoff_base_ms INTEGER NOT NULL,
          backoff_max_ms INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          metadata_json TEXT NOT NULL
        );
        CREATE TABLE schedule_runs (
          run_id TEXT PRIMARY KEY,
          schedule_id TEXT NOT NULL,
          attempt_number INTEGER NOT NULL,
          status TEXT NOT NULL,
          scheduled_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          task_id TEXT,
          session_id TEXT,
          error_code TEXT,
          error_message TEXT,
          trigger TEXT NOT NULL,
          metadata_json TEXT NOT NULL
        );
        PRAGMA user_version = 25;
      `);
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO schedules (
          schedule_id, name, status, session_id, owner_user_id, cwd, agent_profile_id, provider_name,
          input, cron, interval_ms, run_at, timezone, next_fire_at, last_fire_at, max_attempts,
          backoff_base_ms, backoff_max_ms, created_at, updated_at, metadata_json
        ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 3, 1000, 5000, ?, ?, ?)`
      ).run(
        "sched-dup",
        "dup",
        "active",
        "u1",
        "/tmp/ws",
        "executor",
        "mock",
        "work",
        now,
        now,
        "{}"
      );
      db.prepare(
        `INSERT INTO schedule_runs (
          run_id, schedule_id, attempt_number, status, scheduled_at, started_at, finished_at,
          task_id, session_id, error_code, error_message, trigger, metadata_json
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`
      ).run("run-old", "sched-dup", 1, "queued", "2026-01-01T00:00:00.000Z", "scheduled", "{}");
      db.prepare(
        `INSERT INTO schedule_runs (
          run_id, schedule_id, attempt_number, status, scheduled_at, started_at, finished_at,
          task_id, session_id, error_code, error_message, trigger, metadata_json
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`
      ).run("run-new", "sched-dup", 2, "running", "2026-01-02T00:00:00.000Z", "scheduled", "{}");

      expect(() => runMigrations(db)).not.toThrow();

      const rows = db
        .prepare("SELECT run_id, status FROM schedule_runs WHERE schedule_id = 'sched-dup' ORDER BY run_id")
        .all() as Array<{ run_id: string; status: string }>;
      expect(rows).toEqual([
        { run_id: "run-new", status: "running" },
        { run_id: "run-old", status: "cancelled" }
      ]);
      const index = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_schedule_runs_one_active'")
        .get() as { name?: string } | undefined;
      expect(index?.name).toBe("idx_schedule_runs_one_active");
      const userVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };
      expect(userVersion.user_version).toBe(RUNTIME_SCHEMA_VERSION);
    } finally {
      db.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });
});

function tableNames(db: DatabaseSync): string[] {
  return (db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>).map((row) => row.name);
}
