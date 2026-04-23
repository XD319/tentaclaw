import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  JsonObject,
  ThreadSnapshotDraft,
  ThreadSnapshotRecord,
  ThreadSnapshotRepository
} from "../../types/index.js";

import { parseJsonValue, serializeJsonValue } from "./json.js";

interface ThreadSnapshotRow {
  snapshot_id: string;
  thread_id: string;
  run_id: string | null;
  task_id: string | null;
  trigger: ThreadSnapshotRecord["trigger"];
  goal: string;
  open_loops_json: string;
  blocked_reason: string | null;
  next_actions_json: string;
  active_memory_ids_json: string;
  tool_capability_summary_json: string;
  summary: string;
  created_at: string;
  metadata_json: string;
}

export class SqliteThreadSnapshotRepository implements ThreadSnapshotRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(record: ThreadSnapshotDraft): ThreadSnapshotRecord {
    const snapshotId = record.snapshotId || randomUUID();
    const createdAt = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO thread_snapshots (
          snapshot_id, thread_id, run_id, task_id, trigger, goal, open_loops_json, blocked_reason,
          next_actions_json, active_memory_ids_json, tool_capability_summary_json, summary, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        snapshotId,
        record.threadId,
        record.runId ?? null,
        record.taskId ?? null,
        record.trigger,
        record.goal,
        serializeJsonValue(record.openLoops),
        record.blockedReason ?? null,
        serializeJsonValue(record.nextActions),
        serializeJsonValue(record.activeMemoryIds),
        serializeJsonValue(record.toolCapabilitySummary),
        record.summary,
        createdAt,
        serializeJsonValue(record.metadata ?? {})
      );
    const created = this.findById(snapshotId);
    if (created === null) {
      throw new Error(`Thread snapshot ${snapshotId} was not persisted.`);
    }
    return created;
  }

  public findById(snapshotId: string): ThreadSnapshotRecord | null {
    const row = this.database
      .prepare("SELECT * FROM thread_snapshots WHERE snapshot_id = ?")
      .get(snapshotId) as ThreadSnapshotRow | undefined;
    return row === undefined ? null : this.mapRow(row);
  }

  public findLatestByThread(threadId: string): ThreadSnapshotRecord | null {
    const row = this.database
      .prepare(
        "SELECT * FROM thread_snapshots WHERE thread_id = ? ORDER BY created_at DESC, snapshot_id DESC LIMIT 1"
      )
      .get(threadId) as ThreadSnapshotRow | undefined;
    return row === undefined ? null : this.mapRow(row);
  }

  public listByThread(threadId: string): ThreadSnapshotRecord[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM thread_snapshots WHERE thread_id = ? ORDER BY created_at DESC, snapshot_id DESC"
      )
      .all(threadId) as unknown as ThreadSnapshotRow[];
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: ThreadSnapshotRow): ThreadSnapshotRecord {
    return {
      snapshotId: row.snapshot_id,
      threadId: row.thread_id,
      runId: row.run_id,
      taskId: row.task_id,
      trigger: row.trigger,
      goal: row.goal,
      openLoops: parseJsonValue<string[]>(row.open_loops_json),
      blockedReason: row.blocked_reason,
      nextActions: parseJsonValue<string[]>(row.next_actions_json),
      activeMemoryIds: parseJsonValue<string[]>(row.active_memory_ids_json),
      toolCapabilitySummary: parseJsonValue<string[]>(row.tool_capability_summary_json),
      summary: row.summary,
      createdAt: row.created_at,
      metadata: parseJsonValue<JsonObject>(row.metadata_json)
    };
  }
}
