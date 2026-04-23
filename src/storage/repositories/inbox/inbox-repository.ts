import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  InboxItem,
  InboxItemDraft,
  InboxItemUpdatePatch,
  InboxListQuery,
  InboxRepository,
  JsonObject
} from "../../../types/index.js";

import { parseJsonValue, serializeJsonValue } from "../json.js";

interface InboxItemRow {
  inbox_id: string;
  user_id: string;
  task_id: string | null;
  thread_id: string | null;
  schedule_run_id: string | null;
  approval_id: string | null;
  experience_id: string | null;
  skill_id: string | null;
  category: InboxItem["category"];
  severity: InboxItem["severity"];
  status: InboxItem["status"];
  title: string;
  summary: string;
  body_md: string | null;
  action_hint: string | null;
  source_trace_id: string | null;
  dedup_key: string | null;
  created_at: string;
  updated_at: string;
  done_at: string | null;
  metadata_json: string;
}

export class SqliteInboxRepository implements InboxRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(record: InboxItemDraft): InboxItem {
    const now = new Date().toISOString();
    const inboxId = record.inboxId ?? randomUUID();
    this.database
      .prepare(
        `INSERT INTO inbox_items (
          inbox_id, user_id, task_id, thread_id, schedule_run_id, approval_id, experience_id, skill_id,
          category, severity, status, title, summary, body_md, action_hint, source_trace_id, dedup_key,
          created_at, updated_at, done_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        inboxId,
        record.userId,
        record.taskId ?? null,
        record.threadId ?? null,
        record.scheduleRunId ?? null,
        record.approvalId ?? null,
        record.experienceId ?? null,
        record.skillId ?? null,
        record.category,
        record.severity,
        record.status ?? "pending",
        record.title,
        record.summary,
        record.bodyMd ?? null,
        record.actionHint ?? null,
        record.sourceTraceId ?? null,
        record.dedupKey ?? null,
        now,
        now,
        record.doneAt ?? null,
        serializeJsonValue(record.metadata ?? {})
      );
    const persisted = this.findById(inboxId);
    if (persisted === null) {
      throw new Error(`Inbox item ${inboxId} was not persisted.`);
    }
    return persisted;
  }

  public findById(inboxId: string): InboxItem | null {
    const row = this.database
      .prepare("SELECT * FROM inbox_items WHERE inbox_id = ?")
      .get(inboxId) as InboxItemRow | undefined;
    return row === undefined ? null : this.mapRow(row);
  }

  public findByDedup(query: { userId: string; dedupKey: string }): InboxItem | null {
    const row = this.database
      .prepare("SELECT * FROM inbox_items WHERE user_id = ? AND dedup_key = ?")
      .get(query.userId, query.dedupKey) as InboxItemRow | undefined;
    return row === undefined ? null : this.mapRow(row);
  }

  public list(query: InboxListQuery = {}): InboxItem[] {
    const clauses: string[] = [];
    const values: Array<number | string> = [];
    if (query.userId !== undefined) {
      clauses.push("user_id = ?");
      values.push(query.userId);
    }
    if (query.taskId !== undefined) {
      clauses.push("task_id = ?");
      values.push(query.taskId);
    }
    if (query.threadId !== undefined) {
      clauses.push("thread_id = ?");
      values.push(query.threadId);
    }
    if (query.category !== undefined) {
      clauses.push("category = ?");
      values.push(query.category);
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
      .prepare(`SELECT * FROM inbox_items${whereClause} ORDER BY created_at DESC${limitClause}`)
      .all(...values) as unknown as InboxItemRow[];
    return rows.map((row) => this.mapRow(row));
  }

  public update(inboxId: string, patch: InboxItemUpdatePatch): InboxItem {
    const existing = this.findById(inboxId);
    if (existing === null) {
      throw new Error(`Inbox item ${inboxId} was not found.`);
    }
    const next: InboxItem = {
      ...existing,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.bodyMd !== undefined ? { bodyMd: patch.bodyMd } : {}),
      ...(patch.actionHint !== undefined ? { actionHint: patch.actionHint } : {}),
      ...(patch.doneAt !== undefined ? { doneAt: patch.doneAt } : {}),
      ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
      updatedAt: new Date().toISOString()
    };
    this.database
      .prepare(
        `UPDATE inbox_items
         SET status = ?, title = ?, summary = ?, body_md = ?, action_hint = ?, done_at = ?, metadata_json = ?, updated_at = ?
         WHERE inbox_id = ?`
      )
      .run(
        next.status,
        next.title,
        next.summary,
        next.bodyMd,
        next.actionHint,
        next.doneAt,
        serializeJsonValue(next.metadata),
        next.updatedAt,
        inboxId
      );
    return next;
  }

  private mapRow(row: InboxItemRow): InboxItem {
    return {
      inboxId: row.inbox_id,
      userId: row.user_id,
      taskId: row.task_id,
      threadId: row.thread_id,
      scheduleRunId: row.schedule_run_id,
      approvalId: row.approval_id,
      experienceId: row.experience_id,
      skillId: row.skill_id,
      category: row.category,
      severity: row.severity,
      status: row.status,
      title: row.title,
      summary: row.summary,
      bodyMd: row.body_md,
      actionHint: row.action_hint,
      sourceTraceId: row.source_trace_id,
      dedupKey: row.dedup_key,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      doneAt: row.done_at,
      metadata: parseJsonValue<JsonObject>(row.metadata_json)
    };
  }
}
