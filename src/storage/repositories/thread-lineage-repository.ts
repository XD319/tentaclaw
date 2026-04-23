import type { DatabaseSync } from "node:sqlite";

import type {
  JsonObject,
  ThreadLineageDraft,
  ThreadLineageRecord,
  ThreadLineageRepository
} from "../../types/index.js";

import { parseJsonValue, serializeJsonValue } from "./json.js";

interface ThreadLineageRow {
  lineage_id: string;
  thread_id: string;
  event_type: ThreadLineageRecord["eventType"];
  source_run_id: string | null;
  target_run_id: string | null;
  created_at: string;
  payload_json: string;
}

export class SqliteThreadLineageRepository implements ThreadLineageRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public append(record: ThreadLineageDraft): ThreadLineageRecord {
    const createdAt = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO thread_lineage (
          lineage_id, thread_id, event_type, source_run_id, target_run_id, created_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.lineageId,
        record.threadId,
        record.eventType,
        record.sourceRunId ?? null,
        record.targetRunId ?? null,
        createdAt,
        serializeJsonValue(record.payload ?? {})
      );
    const created = this.database
      .prepare("SELECT * FROM thread_lineage WHERE lineage_id = ?")
      .get(record.lineageId) as ThreadLineageRow | undefined;
    if (created === undefined) {
      throw new Error(`Thread lineage ${record.lineageId} was not persisted.`);
    }
    return this.mapRow(created);
  }

  public listByThreadId(threadId: string): ThreadLineageRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM thread_lineage WHERE thread_id = ? ORDER BY created_at ASC")
      .all(threadId) as unknown as ThreadLineageRow[];
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: ThreadLineageRow): ThreadLineageRecord {
    return {
      lineageId: row.lineage_id,
      threadId: row.thread_id,
      eventType: row.event_type,
      sourceRunId: row.source_run_id,
      targetRunId: row.target_run_id,
      createdAt: row.created_at,
      payload: parseJsonValue<JsonObject>(row.payload_json)
    };
  }
}
