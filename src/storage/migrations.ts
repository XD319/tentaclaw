import type { DatabaseSync } from "node:sqlite";

export function runMigrations(database: DatabaseSync): void {
  const currentVersion = readUserVersion(database);
  const migrations: Array<{ description: string; up: (db: DatabaseSync) => void; version: number }> = [
    {
      description: "create base runtime tables",
      up: migrateV1,
      version: 1
    },
    {
      description: "add profile and requester columns",
      up: migrateV2,
      version: 2
    },
    {
      description: "add thread first-class tables",
      up: migrateV3,
      version: 3
    },
    {
      description: "add thread snapshots table",
      up: migrateV4,
      version: 4
    },
    {
      description: "add schedule and schedule run tables",
      up: migrateV5,
      version: 5
    },
    {
      description: "add inbox items table",
      up: migrateV6,
      version: 6
    },
    {
      description: "add commitments and next actions tables",
      up: migrateV7,
      version: 7
    },
    {
      description: "rename legacy memory scopes to layered names",
      up: migrateV8,
      version: 8
    }
  ];

  for (const migration of migrations) {
    if (migration.version <= currentVersion) {
      continue;
    }
    migration.up(database);
    database.exec(`PRAGMA user_version = ${migration.version}`);
  }
}

function migrateV1(database: DatabaseSync): void {
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      input TEXT NOT NULL,
      status TEXT NOT NULL,
      cwd TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      agent_profile_id TEXT NOT NULL DEFAULT 'executor',
      requester_user_id TEXT NOT NULL DEFAULT 'local-user',
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
      agent_profile_id TEXT NOT NULL DEFAULT 'executor',
      requester_user_id TEXT NOT NULL DEFAULT 'local-user',
      timeout_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      token_budget_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approvals (
      approval_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      requester_user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      decided_at TEXT,
      reviewer_id TEXT,
      reviewer_notes TEXT,
      policy_decision_id TEXT NOT NULL,
      error_code TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_approvals_task_id ON approvals(task_id, requested_at);
    CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(status, expires_at);

    CREATE TABLE IF NOT EXISTS audit_logs (
      audit_id TEXT PRIMARY KEY,
      task_id TEXT,
      tool_call_id TEXT,
      approval_id TEXT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_logs_task_id ON audit_logs(task_id, created_at);

    CREATE TABLE IF NOT EXISTS execution_checkpoints (
      task_id TEXT PRIMARY KEY,
      iteration INTEGER NOT NULL,
      memory_context_json TEXT NOT NULL,
      messages_json TEXT NOT NULL,
      pending_tool_calls_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memories (
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

    CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, scope_key, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status, expires_at);

    CREATE TABLE IF NOT EXISTS experiences (
      experience_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source_type TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      content TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      scope_name TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      confidence REAL NOT NULL,
      value_score REAL NOT NULL,
      promotion_target TEXT,
      promoted_memory_id TEXT,
      provenance_json TEXT NOT NULL,
      task_id TEXT,
      reviewer_id TEXT,
      keywords_json TEXT NOT NULL,
      keyword_phrases_json TEXT NOT NULL,
      index_signals_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      reviewed_at TEXT,
      promoted_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_experiences_status_value
      ON experiences(status, value_score DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_experiences_type_source
      ON experiences(type, source_type, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_experiences_scope
      ON experiences(scope_name, scope_key, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_experiences_task
      ON experiences(task_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_experiences_reviewer
      ON experiences(reviewer_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS memory_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      memory_ids_json TEXT NOT NULL,
      summary TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_snapshots_scope
      ON memory_snapshots(scope, scope_key, created_at DESC);

    CREATE TABLE IF NOT EXISTS gateway_session_bindings (
      session_binding_id TEXT PRIMARY KEY,
      adapter_id TEXT NOT NULL,
      external_session_id TEXT NOT NULL,
      external_user_id TEXT,
      runtime_user_id TEXT NOT NULL,
      task_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_gateway_session_bindings_adapter_session
      ON gateway_session_bindings(adapter_id, external_session_id, created_at DESC);
  `);
}

function migrateV2(database: DatabaseSync): void {
  addColumnIfMissing(database, "tasks", "agent_profile_id", "TEXT NOT NULL DEFAULT 'executor'");
  addColumnIfMissing(database, "tasks", "requester_user_id", "TEXT NOT NULL DEFAULT 'local-user'");
  addColumnIfMissing(
    database,
    "run_metadata",
    "agent_profile_id",
    "TEXT NOT NULL DEFAULT 'executor'"
  );
  addColumnIfMissing(
    database,
    "run_metadata",
    "requester_user_id",
    "TEXT NOT NULL DEFAULT 'local-user'"
  );
}

function migrateV3(database: DatabaseSync): void {
  addColumnIfMissing(database, "tasks", "thread_id", "TEXT");
  database.exec("CREATE INDEX IF NOT EXISTS idx_tasks_thread_id ON tasks(thread_id)");

  database.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      thread_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      agent_profile_id TEXT NOT NULL DEFAULT 'executor',
      provider_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      metadata_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_threads_owner ON threads(owner_user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS thread_runs (
      run_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(thread_id),
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      run_number INTEGER NOT NULL,
      input TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      summary_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_thread_runs_thread ON thread_runs(thread_id, run_number);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_runs_task ON thread_runs(task_id);

    CREATE TABLE IF NOT EXISTS thread_lineage (
      lineage_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(thread_id),
      event_type TEXT NOT NULL,
      source_run_id TEXT,
      target_run_id TEXT,
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_thread_lineage_thread ON thread_lineage(thread_id, created_at);
  `);
}

function migrateV4(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS thread_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(thread_id),
      run_id TEXT,
      task_id TEXT,
      trigger TEXT NOT NULL,
      goal TEXT NOT NULL,
      open_loops_json TEXT NOT NULL,
      blocked_reason TEXT,
      next_actions_json TEXT NOT NULL,
      active_memory_ids_json TEXT NOT NULL,
      tool_capability_summary_json TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_thread_snapshots_thread
      ON thread_snapshots(thread_id, created_at DESC);
  `);
}

function migrateV5(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      schedule_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      thread_id TEXT REFERENCES threads(thread_id),
      owner_user_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      agent_profile_id TEXT NOT NULL DEFAULT 'executor',
      provider_name TEXT NOT NULL,
      input TEXT NOT NULL,
      run_at TEXT,
      interval_ms INTEGER,
      cron TEXT,
      timezone TEXT,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      backoff_base_ms INTEGER NOT NULL DEFAULT 5000,
      backoff_max_ms INTEGER NOT NULL DEFAULT 300000,
      next_fire_at TEXT,
      last_fire_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_schedules_status_fire
      ON schedules(status, next_fire_at);

    CREATE TABLE IF NOT EXISTS schedule_runs (
      run_id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL REFERENCES schedules(schedule_id),
      attempt_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      task_id TEXT REFERENCES tasks(task_id),
      thread_id TEXT REFERENCES threads(thread_id),
      error_code TEXT,
      error_message TEXT,
      trigger TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule
      ON schedule_runs(schedule_id, scheduled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_schedule_runs_status_due
      ON schedule_runs(status, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_schedule_runs_task
      ON schedule_runs(task_id);
  `);
}

function migrateV6(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS inbox_items (
      inbox_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      task_id TEXT REFERENCES tasks(task_id),
      thread_id TEXT REFERENCES threads(thread_id),
      schedule_run_id TEXT REFERENCES schedule_runs(run_id),
      approval_id TEXT REFERENCES approvals(approval_id),
      experience_id TEXT REFERENCES experiences(experience_id),
      skill_id TEXT,
      category TEXT NOT NULL,
      severity TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      body_md TEXT,
      action_hint TEXT,
      source_trace_id TEXT,
      dedup_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      done_at TEXT,
      metadata_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_inbox_user_status_created
      ON inbox_items(user_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_inbox_task
      ON inbox_items(task_id);
    CREATE INDEX IF NOT EXISTS idx_inbox_thread
      ON inbox_items(thread_id);
    CREATE INDEX IF NOT EXISTS idx_inbox_approval
      ON inbox_items(approval_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_user_dedup
      ON inbox_items(user_id, dedup_key)
      WHERE dedup_key IS NOT NULL;
  `);
}

function migrateV7(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS commitments (
      commitment_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(thread_id),
      task_id TEXT REFERENCES tasks(task_id),
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

    CREATE INDEX IF NOT EXISTS idx_commitments_thread_status_updated
      ON commitments(thread_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_commitments_owner_status_updated
      ON commitments(owner_user_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS next_actions (
      next_action_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(thread_id),
      commitment_id TEXT REFERENCES commitments(commitment_id),
      task_id TEXT REFERENCES tasks(task_id),
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

    CREATE INDEX IF NOT EXISTS idx_next_actions_thread_status_rank
      ON next_actions(thread_id, status, rank);
    CREATE INDEX IF NOT EXISTS idx_next_actions_commitment_rank
      ON next_actions(commitment_id, rank);
  `);
}

function migrateV8(database: DatabaseSync): void {
  database.exec(`
    UPDATE memories
    SET scope = 'profile'
    WHERE scope = 'agent';

    UPDATE memories
    SET retention_policy_json = json_set(retention_policy_json, '$.kind', 'profile')
    WHERE json_extract(retention_policy_json, '$.kind') = 'agent';

    UPDATE memories
    SET retention_policy_json = json_set(retention_policy_json, '$.kind', 'working')
    WHERE json_extract(retention_policy_json, '$.kind') = 'session';
  `);
}

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

function addColumnIfMissing(
  database: DatabaseSync,
  tableName: string,
  columnName: string,
  definition: string
): void {
  const rows = database
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;

  if (rows.some((row) => row.name === columnName)) {
    return;
  }

  database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}
