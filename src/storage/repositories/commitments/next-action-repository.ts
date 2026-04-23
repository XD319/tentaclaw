import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  JsonObject,
  NextActionDraft,
  NextActionListQuery,
  NextActionRecord,
  NextActionRepository,
  NextActionUpdatePatch
} from "../../../types/index.js";
import { parseJsonValue, serializeJsonValue } from "../json.js";

interface NextActionRow {
  next_action_id: string;
  thread_id: string;
  commitment_id: string | null;
  task_id: string | null;
  title: string;
  detail: string | null;
  status: NextActionRecord["status"];
  rank: number;
  blocked_reason: string | null;
  source: NextActionRecord["source"];
  source_trace_id: string | null;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  metadata_json: string;
}

export class SqliteNextActionRepository implements NextActionRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(record: NextActionDraft): NextActionRecord {
    const now = new Date().toISOString();
    const nextActionId = record.nextActionId ?? randomUUID();
    this.database
      .prepare(
        `INSERT INTO next_actions (
          next_action_id, thread_id, commitment_id, task_id, title, detail, status, rank, blocked_reason,
          source, source_trace_id, due_at, created_at, updated_at, completed_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        nextActionId,
        record.threadId,
        record.commitmentId ?? null,
        record.taskId ?? null,
        record.title,
        record.detail ?? null,
        record.status ?? "pending",
        record.rank ?? 0,
        record.blockedReason ?? null,
        record.source ?? "manual",
        record.sourceTraceId ?? null,
        record.dueAt ?? null,
        now,
        now,
        record.completedAt ?? null,
        serializeJsonValue(record.metadata ?? {})
      );
    const persisted = this.findById(nextActionId);
    if (persisted === null) {
      throw new Error(`Next action ${nextActionId} was not persisted.`);
    }
    return persisted;
  }

  public findById(nextActionId: string): NextActionRecord | null {
    const row = this.database
      .prepare("SELECT * FROM next_actions WHERE next_action_id = ?")
      .get(nextActionId) as NextActionRow | undefined;
    return row === undefined ? null : this.mapRow(row);
  }

  public list(query: NextActionListQuery = {}): NextActionRecord[] {
    const clauses: string[] = [];
    const values: Array<number | string> = [];
    if (query.threadId !== undefined) {
      clauses.push("thread_id = ?");
      values.push(query.threadId);
    }
    if (query.commitmentId !== undefined) {
      clauses.push("commitment_id = ?");
      values.push(query.commitmentId);
    }
    if (query.status !== undefined) {
      clauses.push("status = ?");
      values.push(query.status);
    }
    if (query.statuses !== undefined && query.statuses.length > 0) {
      clauses.push(`status IN (${query.statuses.map(() => "?").join(", ")})`);
      values.push(...query.statuses);
    }
    const whereClause = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const limitClause = query.limit === undefined ? "" : " LIMIT ?";
    if (query.limit !== undefined) {
      values.push(query.limit);
    }
    const rows = this.database
      .prepare(`SELECT * FROM next_actions${whereClause} ORDER BY rank ASC, created_at ASC${limitClause}`)
      .all(...values) as unknown as NextActionRow[];
    return rows.map((row) => this.mapRow(row));
  }

  public update(nextActionId: string, patch: NextActionUpdatePatch): NextActionRecord {
    const existing = this.findById(nextActionId);
    if (existing === null) {
      throw new Error(`Next action ${nextActionId} was not found.`);
    }
    const next: NextActionRecord = {
      ...existing,
      ...(patch.commitmentId !== undefined ? { commitmentId: patch.commitmentId } : {}),
      ...(patch.taskId !== undefined ? { taskId: patch.taskId } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.rank !== undefined ? { rank: patch.rank } : {}),
      ...(patch.blockedReason !== undefined ? { blockedReason: patch.blockedReason } : {}),
      ...(patch.source !== undefined ? { source: patch.source } : {}),
      ...(patch.sourceTraceId !== undefined ? { sourceTraceId: patch.sourceTraceId } : {}),
      ...(patch.dueAt !== undefined ? { dueAt: patch.dueAt } : {}),
      ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
      ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
      updatedAt: new Date().toISOString()
    };
    this.database
      .prepare(
        `UPDATE next_actions
         SET commitment_id = ?, task_id = ?, title = ?, detail = ?, status = ?, rank = ?, blocked_reason = ?,
             source = ?, source_trace_id = ?, due_at = ?, updated_at = ?, completed_at = ?, metadata_json = ?
         WHERE next_action_id = ?`
      )
      .run(
        next.commitmentId,
        next.taskId,
        next.title,
        next.detail,
        next.status,
        next.rank,
        next.blockedReason,
        next.source,
        next.sourceTraceId,
        next.dueAt,
        next.updatedAt,
        next.completedAt,
        serializeJsonValue(next.metadata),
        nextActionId
      );
    return next;
  }

  private mapRow(row: NextActionRow): NextActionRecord {
    return {
      nextActionId: row.next_action_id,
      threadId: row.thread_id,
      commitmentId: row.commitment_id,
      taskId: row.task_id,
      title: row.title,
      detail: row.detail,
      status: row.status,
      rank: row.rank,
      blockedReason: row.blocked_reason,
      source: row.source,
      sourceTraceId: row.source_trace_id,
      dueAt: row.due_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      metadata: parseJsonValue<JsonObject>(row.metadata_json)
    };
  }
}
