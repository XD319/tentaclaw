import type { DatabaseSync } from "node:sqlite";

export function runMigrations(database: DatabaseSync): void {
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      input TEXT NOT NULL,
      status TEXT NOT NULL,
      cwd TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      current_iteration INTEGER NOT NULL,
      max_iterations INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      final_output TEXT,
      error_code TEXT,
      error_message TEXT,
      token_budget_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS traces (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL,
      stage TEXT NOT NULL,
      actor TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_traces_task_id ON traces(task_id, sequence);

    CREATE TABLE IF NOT EXISTS tool_calls (
      tool_call_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      tool_name TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      status TEXT NOT NULL,
      input_json TEXT NOT NULL,
      output_json TEXT,
      summary TEXT,
      requested_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      error_code TEXT,
      error_message TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tool_calls_task_id ON tool_calls(task_id, requested_at);

    CREATE TABLE IF NOT EXISTS artifacts (
      artifact_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      tool_call_id TEXT,
      artifact_type TEXT NOT NULL,
      uri TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_artifacts_task_id ON artifacts(task_id, created_at);

    CREATE TABLE IF NOT EXISTS run_metadata (
      run_metadata_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL UNIQUE,
      runtime_version TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      timeout_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      token_budget_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );
  `);
}
