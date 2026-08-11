import type { DatabaseSync } from "node:sqlite";

interface SchemaMigration {
  description: string;
  up: (db: DatabaseSync) => void;
  version: number;
}

const SCHEMA_MIGRATIONS: SchemaMigration[] = [
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
    description: "add session summarys table",
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
  },
  {
    description: "add session summary and session search tables",
    up: migrateV9,
    version: 9
  },
  {
    description: "split session summary into current state and events",
    up: migrateV10,
    version: 10
  },
  {
    description: "add clarify prompts and approval scope columns",
    up: migrateV11,
    version: 11
  },
  {
    description: "add runtime output events table",
    up: migrateV12,
    version: 12
  },
  {
    description: "add Claude-style clarify prompt payload columns",
    up: migrateV13,
    version: 13
  },
  {
    description: "add clarify prompt response column",
    up: migrateV14,
    version: 14
  },
  {
    description: "add session transcript events table",
    up: migrateV15,
    version: 15
  },
  {
    description: "add output event session id column",
    up: migrateV16,
    version: 16
  },
  {
    description: "repair session core tables",
    up: migrateV17,
    version: 17
  },
  {
    description: "add session messages fts and gateway runtime session id",
    up: migrateV18,
    version: 18
  },
  {
    description: "scope session message ids per session",
    up: migrateV19,
    version: 19
  },
  {
    description: "add session todos table",
    up: migrateV20,
    version: 20
  },
  {
    description: "add session execution locks table",
    up: migrateV21,
    version: 21
  },
  {
    description: "finalize thread to session migration and drop legacy tables",
    up: migrateV22,
    version: 22
  },
  {
    description: "add gateway rate limit persistence table",
    up: migrateV23,
    version: 23
  },
  {
    description: "add Hermes memory tiers, snapshots, embeddings, and trigram search",
    up: migrateV24,
    version: 24
  },
  {
    description: "add memories_fts full-text index for long-term memory search",
    up: migrateV25,
    version: 25
  },
  {
    description: "enforce one active run per schedule",
    up: migrateV26,
    version: 26
  }
];

export const RUNTIME_SCHEMA_VERSION =
  SCHEMA_MIGRATIONS[SCHEMA_MIGRATIONS.length - 1]?.version ?? 0;

export function runMigrations(database: DatabaseSync): void {
  const currentVersion = readUserVersion(database);
  for (const migration of SCHEMA_MIGRATIONS) {
    if (migration.version <= currentVersion) {
      continue;
    }
    migration.up(database);
    database.exec(`PRAGMA user_version = ${migration.version}`);
  }
  ensureSessionSchemaRepairs(database);
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
  addColumnIfMissing(database, "tasks", "session_id", "TEXT");
  database.exec("CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id)");

  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
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

    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS session_tasks (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      run_number INTEGER NOT NULL,
      input TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      summary_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_tasks_thread ON session_tasks(session_id, run_number);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_tasks_task ON session_tasks(task_id);

    CREATE TABLE IF NOT EXISTS session_lineage (
      lineage_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      event_type TEXT NOT NULL,
      source_run_id TEXT,
      target_run_id TEXT,
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_lineage_thread ON session_lineage(session_id, created_at);
  `);
}

function migrateV4(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS legacy_session_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
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

    CREATE INDEX IF NOT EXISTS idx_legacy_session_snapshots_session
      ON legacy_session_snapshots(session_id, created_at DESC);
  `);
}

function migrateV5(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      schedule_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      session_id TEXT REFERENCES sessions(session_id),
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
      session_id TEXT REFERENCES sessions(session_id),
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
      session_id TEXT REFERENCES sessions(session_id),
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
      ON inbox_items(session_id);
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
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
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
      ON commitments(session_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_commitments_owner_status_updated
      ON commitments(owner_user_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS next_actions (
      next_action_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
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
      ON next_actions(session_id, status, rank);
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

function migrateV9(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_summary (
      session_memory_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      run_id TEXT,
      task_id TEXT,
      trigger TEXT NOT NULL,
      summary TEXT NOT NULL,
      goal TEXT NOT NULL,
      decisions_json TEXT NOT NULL,
      open_loops_json TEXT NOT NULL,
      next_actions_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_summary_thread
      ON session_summary(session_id, created_at DESC);
  `);

  try {
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_index USING fts5(
        session_memory_id UNINDEXED,
        session_id UNINDEXED,
        summary,
        goal,
        decisions,
        open_loops,
        next_actions,
        keywords,
        created_at UNINDEXED
      );
    `);
  } catch {
    database.exec(`
      CREATE TABLE IF NOT EXISTS session_index (
        session_memory_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        goal TEXT NOT NULL,
        decisions TEXT NOT NULL,
        open_loops TEXT NOT NULL,
        next_actions TEXT NOT NULL,
        keywords TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_index_thread_created
        ON session_index(session_id, created_at DESC);
    `);
  }
}

function migrateV10(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      owner_user_id TEXT NOT NULL DEFAULT 'local-user',
      cwd TEXT NOT NULL DEFAULT '',
      agent_profile_id TEXT NOT NULL DEFAULT 'executor',
      provider_name TEXT NOT NULL DEFAULT 'unknown',
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      archived_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS session_summary_events (
      session_memory_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      run_id TEXT,
      task_id TEXT,
      trigger TEXT NOT NULL,
      summary TEXT NOT NULL,
      goal TEXT NOT NULL,
      decisions_json TEXT NOT NULL,
      open_loops_json TEXT NOT NULL,
      next_actions_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_summary_events_thread
      ON session_summary_events(session_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS session_summaries_current (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),
      session_memory_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      goal TEXT NOT NULL,
      decisions_json TEXT NOT NULL,
      open_loops_json TEXT NOT NULL,
      next_actions_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );
  `);

  database.exec(`
    INSERT OR IGNORE INTO session_summary_events (
      session_memory_id,
      session_id,
      run_id,
      task_id,
      trigger,
      summary,
      goal,
      decisions_json,
      open_loops_json,
      next_actions_json,
      created_at,
      metadata_json
    )
    SELECT
      session_memory_id,
      session_id,
      run_id,
      task_id,
      trigger,
      summary,
      goal,
      decisions_json,
      open_loops_json,
      next_actions_json,
      created_at,
      metadata_json
    FROM session_summary;
  `);

  database.exec(`
    INSERT INTO session_summaries_current (
      session_id,
      session_memory_id,
      summary,
      goal,
      decisions_json,
      open_loops_json,
      next_actions_json,
      updated_at,
      metadata_json
    )
    SELECT
      source.session_id,
      source.session_memory_id,
      source.summary,
      source.goal,
      source.decisions_json,
      source.open_loops_json,
      source.next_actions_json,
      source.created_at,
      source.metadata_json
    FROM session_summary AS source
    WHERE source.session_memory_id = (
      SELECT candidate.session_memory_id
      FROM session_summary AS candidate
      WHERE candidate.session_id = source.session_id
      ORDER BY candidate.created_at DESC, candidate.rowid DESC
      LIMIT 1
    )
    ON CONFLICT(session_id) DO UPDATE SET
      session_memory_id = excluded.session_memory_id,
      summary = excluded.summary,
      goal = excluded.goal,
      decisions_json = excluded.decisions_json,
      open_loops_json = excluded.open_loops_json,
      next_actions_json = excluded.next_actions_json,
      updated_at = excluded.updated_at,
      metadata_json = excluded.metadata_json;
  `);
}

function migrateV11(database: DatabaseSync): void {
  addColumnIfMissing(database, "approvals", "allow_scope", "TEXT");
  addColumnIfMissing(database, "approvals", "fingerprint", "TEXT");
  addColumnIfMissing(database, "execution_checkpoints", "pending_clarify_prompt_id", "TEXT");

  database.exec(`
    CREATE TABLE IF NOT EXISTS clarify_prompts (
      prompt_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      tool_call_id TEXT NOT NULL REFERENCES tool_calls(tool_call_id),
      requester_user_id TEXT NOT NULL,
      question TEXT NOT NULL,
      reason TEXT,
      options_json TEXT NOT NULL,
      allow_custom_answer INTEGER NOT NULL DEFAULT 0,
      placeholder TEXT,
      status TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      answered_at TEXT,
      answer_option_id TEXT,
      answer_text TEXT,
      reviewer_id TEXT,
      error_code TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_clarify_prompts_task_id
      ON clarify_prompts(task_id, requested_at);
    CREATE INDEX IF NOT EXISTS idx_clarify_prompts_pending
      ON clarify_prompts(status, expires_at);
  `);
}

function migrateV12(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS output_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL,
      session_id TEXT,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL,
      stage TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_output_events_task
      ON output_events(task_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_output_events_thread
      ON output_events(session_id, sequence);
  `);
}

function migrateV13(database: DatabaseSync): void {
  addColumnIfMissing(database, "clarify_prompts", "questions_json", "TEXT");
  addColumnIfMissing(database, "clarify_prompts", "answers_json", "TEXT");
}

function migrateV14(database: DatabaseSync): void {
  addColumnIfMissing(database, "clarify_prompts", "response_text", "TEXT");
}

function migrateV15(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_transcript_events (
      transcript_event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      task_id TEXT REFERENCES tasks(task_id),
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      role TEXT,
      content TEXT,
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_transcript_sequence
      ON session_transcript_events(session_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_session_transcript_task
      ON session_transcript_events(task_id, created_at);
  `);
}

function migrateV16(database: DatabaseSync): void {
  addColumnIfMissing(database, "output_events", "session_id", "TEXT");
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_output_events_session
      ON output_events(session_id, sequence);
  `);
}

function migrateV17(database: DatabaseSync): void {
  ensureSessionSchemaRepairs(database);
}

function migrateV18(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_messages (
      message_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      entry_source TEXT NOT NULL DEFAULT 'unknown'
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_messages_seq
      ON session_messages(session_id, sequence);

    CREATE INDEX IF NOT EXISTS idx_session_messages_session_updated
      ON session_messages(session_id, created_at DESC);
  `);

  try {
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
        message_id UNINDEXED,
        session_id UNINDEXED,
        content,
        tokenize='unicode61'
      );
    `);
  } catch {
    database.exec(`
      CREATE TABLE IF NOT EXISTS session_messages_fts (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        content TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_messages_fts_session
        ON session_messages_fts(session_id);
    `);
  }

  addColumnIfMissing(database, "gateway_session_bindings", "runtime_session_id", "TEXT");
  if (tableExists(database, "gateway_session_bindings")) {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_gateway_session_bindings_runtime_session
        ON gateway_session_bindings(runtime_session_id, created_at DESC);
    `);
  }
}

function migrateV19(database: DatabaseSync): void {
  rebuildSessionMessagesCompositeKey(database);
  rebuildSessionMessagesFts(database);
}

function migrateV20(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_todos (
      session_id TEXT PRIMARY KEY,
      todos_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function migrateV21(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_locks (
      session_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL
    );
  `);
}

function rebuildSessionMessagesCompositeKey(database: DatabaseSync): void {
  if (!tableExists(database, "session_messages")) {
    database.exec(`
      CREATE TABLE session_messages (
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        message_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        entry_source TEXT NOT NULL DEFAULT 'unknown',
        PRIMARY KEY (session_id, message_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_session_messages_seq
        ON session_messages(session_id, sequence);

      CREATE INDEX IF NOT EXISTS idx_session_messages_session_updated
        ON session_messages(session_id, created_at DESC);
    `);
    return;
  }

  const primaryKeyColumns = readPrimaryKeyColumns(database, "session_messages");
  if (
    primaryKeyColumns.length === 2 &&
    primaryKeyColumns.includes("session_id") &&
    primaryKeyColumns.includes("message_id")
  ) {
    return;
  }

  database.exec(`
    CREATE TABLE session_messages__v19 (
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      message_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      entry_source TEXT NOT NULL DEFAULT 'unknown',
      PRIMARY KEY (session_id, message_id)
    );
  `);
  database.exec(`
    INSERT OR IGNORE INTO session_messages__v19 (
      session_id, message_id, sequence, kind, payload_json, created_at, entry_source
    )
    SELECT session_id, message_id, sequence, kind, payload_json, created_at, entry_source
    FROM session_messages;
  `);
  database.exec(`
    DROP TABLE session_messages;
    ALTER TABLE session_messages__v19 RENAME TO session_messages;
  `);
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_messages_seq
      ON session_messages(session_id, sequence);

    CREATE INDEX IF NOT EXISTS idx_session_messages_session_updated
      ON session_messages(session_id, created_at DESC);
  `);
}

function rebuildSessionMessagesFts(database: DatabaseSync): void {
  if (!tableExists(database, "session_messages")) {
    return;
  }

  if (tableExists(database, "session_messages_fts")) {
    database.exec("DROP TABLE session_messages_fts");
  }

  try {
    database.exec(`
      CREATE VIRTUAL TABLE session_messages_fts USING fts5(
        message_id UNINDEXED,
        session_id UNINDEXED,
        content,
        tokenize='unicode61'
      );
    `);
  } catch {
    database.exec(`
      CREATE TABLE session_messages_fts (
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY (session_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_session_messages_fts_session
        ON session_messages_fts(session_id);
    `);
  }

  database.exec(`
    INSERT INTO session_messages_fts(session_id, message_id, content)
    SELECT
      session_id,
      message_id,
      trim(
        coalesce(json_extract(payload_json, '$.text'), '') || char(10) ||
        coalesce(json_extract(payload_json, '$.message'), '') || char(10) ||
        coalesce(json_extract(payload_json, '$.code'), '') || char(10) ||
        coalesce(json_extract(payload_json, '$.title'), '')
      )
    FROM session_messages
    WHERE length(trim(
      coalesce(json_extract(payload_json, '$.text'), '') ||
      coalesce(json_extract(payload_json, '$.message'), '') ||
      coalesce(json_extract(payload_json, '$.code'), '') ||
      coalesce(json_extract(payload_json, '$.title'), '')
    )) > 0;
  `);
}

function readPrimaryKeyColumns(database: DatabaseSync, tableName: string): string[] {
  const rows = database
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string; pk: number }>;
  return rows.filter((row) => row.pk > 0).sort((left, right) => left.pk - right.pk).map((row) => row.name);
}

function migrateV22(database: DatabaseSync): void {
  finalizeLegacyThreadMigration(database);
}

function migrateV23(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS gateway_rate_limits (
      rate_limit_key TEXT PRIMARY KEY,
      tokens REAL NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gateway_rate_limits_updated_at
      ON gateway_rate_limits(updated_at_ms);
  `);
}

function migrateV24(database: DatabaseSync): void {
  if (tableExists(database, "memories")) {
    addColumnIfMissing(database, "memories", "tier", "TEXT NOT NULL DEFAULT 'retrieval'");
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_core
        ON memories(tier, scope, scope_key, status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id TEXT PRIMARY KEY REFERENCES memories(memory_id),
        content_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  if (tableExists(database, "sessions")) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS session_core_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE REFERENCES sessions(session_id),
        profile_scope_key TEXT NOT NULL,
        project_scope_key TEXT NOT NULL,
        profile_memory_ids_json TEXT NOT NULL,
        project_memory_ids_json TEXT NOT NULL,
        profile_text TEXT NOT NULL,
        project_text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  if (tableExists(database, "session_messages_fts") && !tableExists(database, "session_messages_trigram")) {
    try {
      database.exec(`
        CREATE VIRTUAL TABLE session_messages_trigram USING fts5(
          message_id UNINDEXED,
          session_id UNINDEXED,
          content,
          tokenize='trigram'
        );
        INSERT INTO session_messages_trigram(message_id, session_id, content)
        SELECT message_id, session_id, content FROM session_messages_fts;
      `);
    } catch {
      // Older SQLite builds may not provide the trigram tokenizer; LIKE remains available.
    }
  }
}

function migrateV25(database: DatabaseSync): void {
  if (!tableExists(database, "memories")) {
    return;
  }
  rebuildMemoriesFts(database);
}

function migrateV26(database: DatabaseSync): void {
  if (!tableExists(database, "schedule_runs")) {
    return;
  }
  database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_runs_one_active
    ON schedule_runs(schedule_id)
    WHERE status IN ('queued', 'running', 'waiting_approval', 'blocked');`);
}

function rebuildMemoriesFts(database: DatabaseSync): void {
  if (tableExists(database, "memories_fts")) {
    database.exec("DROP TABLE memories_fts");
  }
  if (tableExists(database, "memories_trigram")) {
    database.exec("DROP TABLE memories_trigram");
  }

  try {
    database.exec(`
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        memory_id UNINDEXED,
        scope UNINDEXED,
        scope_key UNINDEXED,
        content,
        tokenize='unicode61'
      );
    `);
  } catch {
    database.exec(`
      CREATE TABLE memories_fts (
        memory_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        content TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_fts_scope
        ON memories_fts(scope, scope_key);
    `);
  }

  database.exec(`
    INSERT INTO memories_fts(memory_id, scope, scope_key, content)
    SELECT
      memory_id,
      scope,
      scope_key,
      trim(coalesce(title, '') || char(10) || coalesce(summary, '') || char(10) || coalesce(content, '') || char(10) || coalesce(keywords_json, ''))
    FROM memories
    WHERE status = 'verified'
      AND privacy_level IN ('public', 'internal')
      AND (expires_at IS NULL OR expires_at > datetime('now'));
  `);

  try {
    database.exec(`
      CREATE VIRTUAL TABLE memories_trigram USING fts5(
        memory_id UNINDEXED,
        scope UNINDEXED,
        scope_key UNINDEXED,
        content,
        tokenize='trigram'
      );
      INSERT INTO memories_trigram(memory_id, scope, scope_key, content)
      SELECT memory_id, scope, scope_key, content FROM memories_fts;
    `);
  } catch {
    // Older SQLite builds may not provide the trigram tokenizer.
  }
}

export function finalizeLegacyThreadMigration(database: DatabaseSync): void {
  ensureCoreSessionTables(database);
  withForeignKeysDisabled(database, () => {
    repairLegacySessionIds(database);
    copyLegacyThreadTables(database);
    copyLegacySessionSummaries(database);
    dropLegacyThreadIdColumns(database);
    dropLegacyThreadTables(database);
    repairSessionIndex(database);
  });
}

const LEGACY_THREAD_TABLES = [
  "threads",
  "thread_runs",
  "thread_lineage",
  "thread_session_memory_events",
  "thread_session_memory",
  "thread_session_memories_current"
] as const;

export function collectLegacySchemaIssues(database: DatabaseSync): string[] {
  const issues: string[] = [];
  for (const tableName of LEGACY_THREAD_TABLES) {
    if (tableExists(database, tableName)) {
      issues.push(`Legacy table still present: ${tableName}`);
    }
  }
  for (const tableName of LEGACY_THREAD_ID_TABLES) {
    if (columnExists(database, tableName, "thread_id")) {
      issues.push(`Legacy column still present: ${tableName}.thread_id`);
    }
  }
  return issues;
}

function dropLegacyThreadTables(database: DatabaseSync): void {
  for (const tableName of LEGACY_THREAD_TABLES) {
    if (tableExists(database, tableName)) {
      database.exec(`DROP TABLE ${tableName}`);
    }
  }
}

function ensureCoreSessionTables(database: DatabaseSync): void {
  addColumnIfMissing(database, "tasks", "session_id", "TEXT");
  if (tableExists(database, "tasks")) {
    database.exec("CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id)");
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
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

    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS session_tasks (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      run_number INTEGER NOT NULL,
      input TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      summary_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_tasks_thread ON session_tasks(session_id, run_number);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_tasks_task ON session_tasks(task_id);

    CREATE TABLE IF NOT EXISTS session_lineage (
      lineage_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      event_type TEXT NOT NULL,
      source_run_id TEXT,
      target_run_id TEXT,
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_lineage_thread ON session_lineage(session_id, created_at);
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS session_summary_events (
      session_memory_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      run_id TEXT,
      task_id TEXT,
      trigger TEXT NOT NULL,
      summary TEXT NOT NULL,
      goal TEXT NOT NULL,
      decisions_json TEXT NOT NULL,
      open_loops_json TEXT NOT NULL,
      next_actions_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_summary_events_session
      ON session_summary_events(session_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS session_summaries_current (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),
      session_memory_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      goal TEXT NOT NULL,
      decisions_json TEXT NOT NULL,
      open_loops_json TEXT NOT NULL,
      next_actions_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );
  `);
}

function ensureSessionSchemaRepairs(database: DatabaseSync): void {
  ensureCoreSessionTables(database);
  repairSessionIndex(database);
  withForeignKeysDisabled(database, () => {
    ensureReferencedSessionsExist(database);
  });
  migrateV24(database);
}

function withForeignKeysDisabled(database: DatabaseSync, action: () => void): void {
  database.exec("PRAGMA foreign_keys = OFF");
  try {
    action();
  } finally {
    ensureReferencedSessionsExist(database);
    database.exec("PRAGMA foreign_keys = ON");
  }
}

function ensureReferencedSessionsExist(database: DatabaseSync): void {
  if (!tableExists(database, "sessions")) {
    return;
  }

  const sources = collectReferencedSessionIdSources(database);
  if (sources.length === 0) {
    return;
  }

  const timestamp = new Date().toISOString();
  database.exec(`
    INSERT OR IGNORE INTO sessions (
      session_id,
      title,
      status,
      owner_user_id,
      cwd,
      agent_profile_id,
      provider_name,
      created_at,
      updated_at,
      archived_at,
      metadata_json
    )
    SELECT
      orphaned.session_id,
      'Recovered session',
      'active',
      'local-user',
      '',
      'executor',
      'unknown',
      '${timestamp}',
      '${timestamp}',
      NULL,
      '{}'
    FROM (
      ${sources.join(" UNION ")}
    ) AS orphaned
    WHERE orphaned.session_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM sessions AS existing
        WHERE existing.session_id = orphaned.session_id
      );
  `);
}

function collectReferencedSessionIdSources(database: DatabaseSync): string[] {
  const sources: string[] = [];
  const addSource = (tableName: string, columnName: string): void => {
    if (!tableExists(database, tableName) || !columnExists(database, tableName, columnName)) {
      return;
    }
    sources.push(
      `SELECT ${columnName} AS session_id FROM ${tableName} WHERE ${columnName} IS NOT NULL`
    );
  };

  for (const tableName of LEGACY_THREAD_ID_TABLES) {
    addSource(tableName, "session_id");
  }

  addSource("session_tasks", "session_id");
  addSource("session_lineage", "session_id");
  addSource("session_summary_events", "session_id");
  addSource("session_summaries_current", "session_id");

  return sources;
}

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

function tableExists(database: DatabaseSync, tableName: string): boolean {
  const tableRow = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name?: string } | undefined;
  return tableRow?.name === tableName;
}

function columnExists(database: DatabaseSync, tableName: string, columnName: string): boolean {
  if (!tableExists(database, tableName)) {
    return false;
  }
  const rows = database
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

function repairLegacySessionIds(database: DatabaseSync): void {
  for (const tableName of LEGACY_THREAD_ID_TABLES) {
    addColumnIfMissing(database, tableName, "session_id", "TEXT");
    if (columnExists(database, tableName, "thread_id")) {
      database.exec(`UPDATE ${tableName} SET session_id = thread_id WHERE session_id IS NULL`);
    }
  }
}

const LEGACY_THREAD_ID_TABLES = [
  "tasks",
  "commitments",
  "next_actions",
  "inbox_items",
  "schedules",
  "schedule_runs",
  "output_events"
] as const;

function dropLegacyThreadIdColumns(database: DatabaseSync): void {
  for (const tableName of LEGACY_THREAD_ID_TABLES) {
    cleanupInterruptedTableMigration(database, tableName);
    if (!tableExists(database, tableName)) {
      continue;
    }
    if (!columnExists(database, tableName, "thread_id") || !columnExists(database, tableName, "session_id")) {
      continue;
    }

    database.exec(`UPDATE ${tableName} SET session_id = thread_id WHERE session_id IS NULL`);

    try {
      database.exec(`ALTER TABLE ${tableName} DROP COLUMN thread_id`);
    } catch {
      rebuildTableWithoutColumn(database, tableName, "thread_id");
    }
  }
}

interface TableColumnInfo {
  dflt_value: string | null;
  name: string;
  notnull: number;
  pk: number;
  type: string;
}

function cleanupInterruptedTableMigration(database: DatabaseSync, tableName: string): void {
  const tempName = `${tableName}__session_migration`;
  if (!tableExists(database, tempName)) {
    return;
  }
  if (!tableExists(database, tableName)) {
    database.exec(`ALTER TABLE ${tempName} RENAME TO ${tableName}`);
    return;
  }
  database.exec(`DROP TABLE ${tempName}`);
}

function rebuildTableWithoutColumn(
  database: DatabaseSync,
  tableName: string,
  columnToDrop: string
): void {
  cleanupInterruptedTableMigration(database, tableName);
  if (!tableExists(database, tableName)) {
    return;
  }

  const columns = database
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as unknown as TableColumnInfo[];
  const kept = columns.filter((column) => column.name !== columnToDrop);
  if (kept.length === 0 || kept.length === columns.length) {
    return;
  }

  const tempName = `${tableName}__session_migration`;
  const columnDefinitions = kept
    .map((column) => formatTableColumnDefinition(column))
    .join(", ");
  const columnNames = kept.map((column) => column.name).join(", ");

  database.exec(`CREATE TABLE ${tempName} (${columnDefinitions})`);
  database.exec(`INSERT INTO ${tempName} (${columnNames}) SELECT ${columnNames} FROM ${tableName}`);
  database.exec(`DROP TABLE ${tableName}`);
  database.exec(`ALTER TABLE ${tempName} RENAME TO ${tableName}`);
}

function formatTableColumnDefinition(column: TableColumnInfo): string {
  const parts = [`${column.name} ${column.type.length > 0 ? column.type : "TEXT"}`];
  if (column.pk === 1) {
    parts.push("PRIMARY KEY");
  }
  if (column.notnull === 1 && column.pk !== 1) {
    parts.push("NOT NULL");
  }
  if (column.dflt_value !== null) {
    parts.push(`DEFAULT ${column.dflt_value}`);
  }
  return parts.join(" ");
}

function copyLegacyThreadTables(database: DatabaseSync): void {
  if (tableExists(database, "threads")) {
    database.exec(`
      INSERT OR IGNORE INTO sessions (
        session_id,
        title,
        status,
        owner_user_id,
        cwd,
        agent_profile_id,
        provider_name,
        created_at,
        updated_at,
        archived_at,
        metadata_json
      )
      SELECT
        thread_id,
        title,
        status,
        owner_user_id,
        cwd,
        agent_profile_id,
        provider_name,
        created_at,
        updated_at,
        archived_at,
        metadata_json
      FROM threads;
    `);
  }

  if (tableExists(database, "thread_runs")) {
    database.exec(`
      INSERT OR IGNORE INTO session_tasks (
        run_id,
        session_id,
        task_id,
        run_number,
        input,
        status,
        created_at,
        finished_at,
        summary_json,
        metadata_json
      )
      SELECT
        run_id,
        thread_id,
        task_id,
        run_number,
        input,
        status,
        created_at,
        finished_at,
        summary_json,
        metadata_json
      FROM thread_runs;
    `);
  }

  if (tableExists(database, "thread_lineage")) {
    database.exec(`
      INSERT OR IGNORE INTO session_lineage (
        lineage_id,
        session_id,
        event_type,
        source_run_id,
        target_run_id,
        created_at,
        payload_json
      )
      SELECT
        lineage_id,
        thread_id,
        event_type,
        source_run_id,
        target_run_id,
        created_at,
        payload_json
      FROM thread_lineage;
    `);
  }
}

function copyLegacySessionSummaries(database: DatabaseSync): void {
  const legacyEventsTable = tableExists(database, "thread_session_memory_events")
    ? "thread_session_memory_events"
    : tableExists(database, "thread_session_memory")
      ? "thread_session_memory"
      : null;

  if (legacyEventsTable !== null) {
    database.exec(`
      INSERT OR IGNORE INTO session_summary_events (
        session_memory_id,
        session_id,
        run_id,
        task_id,
        trigger,
        summary,
        goal,
        decisions_json,
        open_loops_json,
        next_actions_json,
        created_at,
        metadata_json
      )
      SELECT
        session_memory_id,
        thread_id,
        run_id,
        task_id,
        trigger,
        summary,
        goal,
        decisions_json,
        open_loops_json,
        next_actions_json,
        created_at,
        metadata_json
      FROM ${legacyEventsTable};
    `);
  }

  if (tableExists(database, "thread_session_memories_current")) {
    database.exec(`
      INSERT OR REPLACE INTO session_summaries_current (
        session_id,
        session_memory_id,
        summary,
        goal,
        decisions_json,
        open_loops_json,
        next_actions_json,
        updated_at,
        metadata_json
      )
      SELECT
        thread_id,
        session_memory_id,
        summary,
        goal,
        decisions_json,
        open_loops_json,
        next_actions_json,
        updated_at,
        metadata_json
      FROM thread_session_memories_current
    `);
  }
}

function repairSessionIndex(database: DatabaseSync): void {
  if (tableExists(database, "session_index") && !columnExists(database, "session_index", "session_id")) {
    database.exec("DROP TABLE session_index");
  }

  try {
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_index USING fts5(
        session_memory_id UNINDEXED,
        session_id UNINDEXED,
        summary,
        goal,
        decisions,
        open_loops,
        next_actions,
        keywords,
        created_at UNINDEXED
      );
    `);
  } catch {
    database.exec(`
      CREATE TABLE IF NOT EXISTS session_index (
        session_memory_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        goal TEXT NOT NULL,
        decisions TEXT NOT NULL,
        open_loops TEXT NOT NULL,
        next_actions TEXT NOT NULL,
        keywords TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_index_session_created
        ON session_index(session_id, created_at DESC);
    `);
  }

  database.exec(`
    INSERT OR REPLACE INTO session_index (
      session_memory_id,
      session_id,
      summary,
      goal,
      decisions,
      open_loops,
      next_actions,
      keywords,
      created_at
    )
    SELECT
      session_memory_id,
      session_id,
      summary,
      goal,
      decisions_json,
      open_loops_json,
      next_actions_json,
      goal || ' ' || summary || ' ' || decisions_json || ' ' || open_loops_json || ' ' || next_actions_json,
      created_at
    FROM session_summary_events;
  `);
}

function addColumnIfMissing(
  database: DatabaseSync,
  tableName: string,
  columnName: string,
  definition: string
): void {
  if (!tableExists(database, tableName)) {
    return;
  }

  const rows = database
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;

  if (rows.some((row) => row.name === columnName)) {
    return;
  }

  database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}
