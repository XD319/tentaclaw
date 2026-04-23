import type { DatabaseSync } from "node:sqlite";

import type { AuditLogDraft, AuditLogRecord, AuditLogRepository, JsonObject } from "../../types/index.js";

import { parseJsonValue, serializeJsonValue } from "./json.js";

interface AuditLogRow {
  audit_id: string;
  task_id: string | null;
  tool_call_id: string | null;
  approval_id: string | null;
  actor: string;
  action: AuditLogRecord["action"];
  outcome: AuditLogRecord["outcome"];
  summary: string;
  payload_json: string;
  created_at: string;
}

export class SqliteAuditLogRepository implements AuditLogRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public append(record: AuditLogDraft): AuditLogRecord {
    this.database
      .prepare(
        `
          INSERT INTO audit_logs (
            audit_id,
            task_id,
            tool_call_id,
            approval_id,
            actor,
            action,
            outcome,
            summary,
            payload_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        record.auditId,
        record.taskId,
        record.toolCallId,
        record.approvalId,
        record.actor,
        record.action,
        record.outcome,
        record.summary,
        serializeJsonValue(record.payload),
        record.createdAt
      );

    const row = this.database
      .prepare("SELECT * FROM audit_logs WHERE audit_id = ?")
      .get(record.auditId) as AuditLogRow | undefined;

    if (row === undefined) {
      throw new Error(`Audit log ${record.auditId} was not persisted.`);
    }

    return this.mapRow(row);
  }

  public listByTaskId(taskId: string): AuditLogRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM audit_logs WHERE task_id = ? ORDER BY created_at ASC, audit_id ASC")
      .all(taskId) as unknown as AuditLogRow[];

    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: AuditLogRow): AuditLogRecord {
    return {
      action: row.action,
      actor: row.actor,
      approvalId: row.approval_id,
      auditId: row.audit_id,
      createdAt: row.created_at,
      outcome: row.outcome,
      payload: parseJsonValue<JsonObject>(row.payload_json),
      summary: row.summary,
      taskId: row.task_id,
      toolCallId: row.tool_call_id
    };
  }
}
