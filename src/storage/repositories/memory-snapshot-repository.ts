import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  JsonObject,
  MemorySnapshotDraft,
  MemorySnapshotRecord,
  MemorySnapshotRepository
} from "../../types/index.js";

import { parseJsonValue, serializeJsonValue } from "./json.js";

interface MemorySnapshotRow {
  snapshot_id: string;
  scope: MemorySnapshotRecord["scope"];
  scope_key: string;
  label: string;
  created_at: string;
  created_by: string;
  memory_ids_json: string;
  summary: string;
  metadata_json: string;
}

export class SqliteMemorySnapshotRepository implements MemorySnapshotRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(record: MemorySnapshotDraft): MemorySnapshotRecord {
    const snapshotId = randomUUID();
    const createdAt = new Date().toISOString();
    this.database
      .prepare(
        `
          INSERT INTO memory_snapshots (
            snapshot_id,
            scope,
            scope_key,
            label,
            created_at,
            created_by,
            memory_ids_json,
            summary,
            metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        snapshotId,
        record.scope,
        record.scopeKey,
        record.label,
        createdAt,
        record.createdBy,
        serializeJsonValue(record.memoryIds),
        record.summary,
        serializeJsonValue(record.metadata ?? {})
      );

    return this.findById(snapshotId) ?? {
      createdAt,
      createdBy: record.createdBy,
      label: record.label,
      memoryIds: record.memoryIds,
      metadata: record.metadata ?? {},
      scope: record.scope,
      scopeKey: record.scopeKey,
      snapshotId,
      summary: record.summary
    };
  }

  public findById(snapshotId: string): MemorySnapshotRecord | null {
    const row = this.database
      .prepare("SELECT * FROM memory_snapshots WHERE snapshot_id = ?")
      .get(snapshotId) as MemorySnapshotRow | undefined;

    return row === undefined ? null : this.mapRow(row);
  }

  public listByScope(
    scope: MemorySnapshotRecord["scope"],
    scopeKey: string
  ): MemorySnapshotRecord[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM memory_snapshots WHERE scope = ? AND scope_key = ? ORDER BY created_at DESC"
      )
      .all(scope, scopeKey) as unknown as MemorySnapshotRow[];

    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: MemorySnapshotRow): MemorySnapshotRecord {
    return {
      createdAt: row.created_at,
      createdBy: row.created_by,
      label: row.label,
      memoryIds: parseJsonValue<string[]>(row.memory_ids_json),
      metadata: parseJsonValue<JsonObject>(row.metadata_json),
      scope: row.scope,
      scopeKey: row.scope_key,
      snapshotId: row.snapshot_id,
      summary: row.summary
    };
  }
}
