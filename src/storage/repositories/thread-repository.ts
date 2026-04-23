import type { DatabaseSync } from "node:sqlite";

import type {
  JsonObject,
  ThreadListQuery,
  ThreadRecord,
  ThreadRepository,
  ThreadStatus,
  ThreadUpdatePatch
} from "../../types/index.js";
import type { AgentProfileId } from "../../types/profile.js";
import type { ThreadDraft } from "../../types/thread.js";

import { parseJsonValue, serializeJsonValue } from "./json.js";

interface ThreadRow {
  thread_id: string;
  title: string;
  status: ThreadStatus;
  owner_user_id: string;
  cwd: string;
  agent_profile_id: AgentProfileId;
  provider_name: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  metadata_json: string;
}

export class SqliteThreadRepository implements ThreadRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(thread: ThreadDraft): ThreadRecord {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO threads (
          thread_id, title, status, owner_user_id, cwd, agent_profile_id, provider_name,
          created_at, updated_at, archived_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        thread.threadId,
        thread.title,
        "active",
        thread.ownerUserId,
        thread.cwd,
        thread.agentProfileId,
        thread.providerName,
        now,
        now,
        null,
        serializeJsonValue(thread.metadata ?? {})
      );

    const created = this.findById(thread.threadId);
    if (created === null) {
      throw new Error(`Thread ${thread.threadId} was not persisted.`);
    }
    return created;
  }

  public findById(threadId: string): ThreadRecord | null {
    const row = this.database
      .prepare("SELECT * FROM threads WHERE thread_id = ?")
      .get(threadId) as ThreadRow | undefined;
    return row === undefined ? null : this.mapRow(row);
  }

  public list(query?: ThreadListQuery): ThreadRecord[] {
    const where: string[] = [];
    const params: string[] = [];
    if (query?.ownerUserId !== undefined) {
      where.push("owner_user_id = ?");
      params.push(query.ownerUserId);
    }
    if (query?.status !== undefined) {
      where.push("status = ?");
      params.push(query.status);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.database
      .prepare(`SELECT * FROM threads ${whereSql} ORDER BY updated_at DESC`)
      .all(...params) as unknown as ThreadRow[];
    return rows.map((row) => this.mapRow(row));
  }

  public update(threadId: string, patch: ThreadUpdatePatch): ThreadRecord {
    const existing = this.findById(threadId);
    if (existing === null) {
      throw new Error(`Thread ${threadId} was not found.`);
    }
    const next: ThreadRecord = {
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.archivedAt !== undefined ? { archivedAt: patch.archivedAt } : {}),
      ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
      updatedAt: new Date().toISOString()
    };

    this.database
      .prepare(
        `UPDATE threads
         SET title = ?, status = ?, updated_at = ?, archived_at = ?, metadata_json = ?
         WHERE thread_id = ?`
      )
      .run(
        next.title,
        next.status,
        next.updatedAt,
        next.archivedAt,
        serializeJsonValue(next.metadata),
        threadId
      );
    return next;
  }

  public findLatestByOwner(ownerUserId: string): ThreadRecord | null {
    const row = this.database
      .prepare("SELECT * FROM threads WHERE owner_user_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(ownerUserId) as ThreadRow | undefined;
    return row === undefined ? null : this.mapRow(row);
  }

  private mapRow(row: ThreadRow): ThreadRecord {
    return {
      threadId: row.thread_id,
      title: row.title,
      status: row.status,
      ownerUserId: row.owner_user_id,
      cwd: row.cwd,
      agentProfileId: row.agent_profile_id,
      providerName: row.provider_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
      metadata: parseJsonValue<JsonObject>(row.metadata_json)
    };
  }
}
