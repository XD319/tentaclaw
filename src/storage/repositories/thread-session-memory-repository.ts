import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  JsonObject,
  SessionSearchHit,
  ThreadSessionMemoryDraft,
  ThreadSessionMemoryRecord,
  ThreadSessionMemoryRepository
} from "../../types/index.js";
import { parseJsonValue, serializeJsonValue } from "./json.js";

interface ThreadSessionMemoryEventRow {
  session_memory_id: string;
  thread_id: string;
  run_id: string | null;
  task_id: string | null;
  trigger: ThreadSessionMemoryRecord["trigger"];
  summary: string;
  goal: string;
  decisions_json: string;
  open_loops_json: string;
  next_actions_json: string;
  created_at: string;
  metadata_json: string;
}

interface SessionIndexRow {
  session_memory_id: string;
  thread_id: string;
  summary: string;
  goal: string;
  decisions: string;
  open_loops: string;
  next_actions: string;
  created_at: string;
  score: number;
}

type SqlParameter = string | number | bigint | Buffer | Uint8Array | null;

export class SqliteThreadSessionMemoryRepository implements ThreadSessionMemoryRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(record: ThreadSessionMemoryDraft): ThreadSessionMemoryRecord {
    const sessionMemoryId = record.sessionMemoryId ?? randomUUID();
    const createdAt = new Date().toISOString();
    const decisionsJson = serializeJsonValue(record.decisions);
    const openLoopsJson = serializeJsonValue(record.openLoops);
    const nextActionsJson = serializeJsonValue(record.nextActions);
    const metadataJson = serializeJsonValue(record.metadata ?? {});

    this.database.exec("BEGIN");
    try {
      this.database
        .prepare(
          `INSERT INTO thread_session_memory_events (
            session_memory_id, thread_id, run_id, task_id, trigger, summary, goal,
            decisions_json, open_loops_json, next_actions_json, created_at, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          sessionMemoryId,
          record.threadId,
          record.runId ?? null,
          record.taskId ?? null,
          record.trigger,
          record.summary,
          record.goal,
          decisionsJson,
          openLoopsJson,
          nextActionsJson,
          createdAt,
          metadataJson
        );

      this.database
        .prepare(
          `INSERT INTO thread_session_memories_current (
            thread_id, session_memory_id, summary, goal,
            decisions_json, open_loops_json, next_actions_json, updated_at, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(thread_id) DO UPDATE SET
            session_memory_id = excluded.session_memory_id,
            summary = excluded.summary,
            goal = excluded.goal,
            decisions_json = excluded.decisions_json,
            open_loops_json = excluded.open_loops_json,
            next_actions_json = excluded.next_actions_json,
            updated_at = excluded.updated_at,
            metadata_json = excluded.metadata_json`
        )
        .run(
          record.threadId,
          sessionMemoryId,
          record.summary,
          record.goal,
          decisionsJson,
          openLoopsJson,
          nextActionsJson,
          createdAt,
          metadataJson
        );

      const keywordText = uniqueTokens([
        record.goal,
        record.summary,
        ...record.decisions,
        ...record.openLoops,
        ...record.nextActions
      ]).join(" ");

      this.database
        .prepare(
          `INSERT OR REPLACE INTO session_index (
            session_memory_id, thread_id, summary, goal, decisions, open_loops, next_actions, keywords, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          sessionMemoryId,
          record.threadId,
          record.summary,
          record.goal,
          record.decisions.join("\n"),
          record.openLoops.join("\n"),
          record.nextActions.join("\n"),
          keywordText,
          createdAt
        );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    const created = this.findById(sessionMemoryId);
    if (created === null) {
      throw new Error(`Thread session memory ${sessionMemoryId} was not persisted.`);
    }
    return created;
  }

  public findById(sessionMemoryId: string): ThreadSessionMemoryRecord | null {
    const row = this.database
      .prepare("SELECT * FROM thread_session_memory_events WHERE session_memory_id = ?")
      .get(sessionMemoryId) as ThreadSessionMemoryEventRow | undefined;
    return row === undefined ? null : this.mapRow(row);
  }

  public findLatestByThread(threadId: string): ThreadSessionMemoryRecord | null {
    const row = this.database
      .prepare(
        `SELECT
          current.thread_id,
          current.session_memory_id,
          events.run_id,
          events.task_id,
          events.trigger,
          current.summary,
          current.goal,
          current.decisions_json,
          current.open_loops_json,
          current.next_actions_json,
          current.updated_at AS created_at,
          current.metadata_json
        FROM thread_session_memories_current AS current
        LEFT JOIN thread_session_memory_events AS events
          ON events.session_memory_id = current.session_memory_id
        WHERE current.thread_id = ?
        LIMIT 1`
      )
      .get(threadId) as ThreadSessionMemoryEventRow | undefined;
    return row === undefined ? null : this.mapRow(row);
  }

  public listByThread(threadId: string): ThreadSessionMemoryRecord[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM thread_session_memory_events WHERE thread_id = ? ORDER BY created_at DESC, session_memory_id DESC"
      )
      .all(threadId) as unknown as ThreadSessionMemoryEventRow[];
    return rows.map((row) => this.mapRow(row));
  }

  public search(input: { limit: number; query: string; threadId: string }): SessionSearchHit[] {
    const rows = this.searchFts(input) ?? this.searchFallback(input);
    return rows.map((row) => this.mapSearchRow(row));
  }

  public searchGlobal(input: {
    limit: number;
    query: string;
    excludeThreadId?: string | null;
  }): SessionSearchHit[] {
    const rows = this.searchGlobalFts(input) ?? this.searchGlobalFallback(input);
    return rows.map((row) => this.mapSearchRow(row));
  }

  private searchFts(input: { limit: number; query: string; threadId: string }): SessionIndexRow[] | null {
    const whereClause = "thread_id = ? AND session_index MATCH ?";
    const parameters: SqlParameter[] = [input.threadId, input.query, input.limit];
    return this.searchFtsWithQuery(whereClause, parameters);
  }

  private searchGlobalFts(input: {
    limit: number;
    query: string;
    excludeThreadId?: string | null;
  }): SessionIndexRow[] | null {
    const whereClauses = ["session_index MATCH ?"];
    const parameters: SqlParameter[] = [input.query];
    if (input.excludeThreadId !== undefined && input.excludeThreadId !== null) {
      whereClauses.push("thread_id != ?");
      parameters.push(input.excludeThreadId);
    }
    parameters.push(input.limit);
    return this.searchFtsWithQuery(whereClauses.join(" AND "), parameters);
  }

  private searchFtsWithQuery(whereClause: string, parameters: SqlParameter[]): SessionIndexRow[] | null {
    try {
      return this.database
        .prepare(
          `SELECT
            session_memory_id,
            thread_id,
            summary,
            goal,
            decisions,
            open_loops,
            next_actions,
            created_at,
            bm25(session_index) AS score
          FROM session_index
          WHERE ${whereClause}
          ORDER BY score ASC, created_at DESC
          LIMIT ?`
        )
        .all(...parameters) as unknown as SessionIndexRow[];
    } catch {
      return null;
    }
  }

  private searchFallback(input: { limit: number; query: string; threadId: string }): SessionIndexRow[] {
    return this.searchFallbackByScope({
      limit: input.limit,
      query: input.query,
      whereClause: "thread_id = ?",
      whereParams: [input.threadId]
    });
  }

  private searchGlobalFallback(input: {
    limit: number;
    query: string;
    excludeThreadId?: string | null;
  }): SessionIndexRow[] {
    const hasExclude = input.excludeThreadId !== undefined && input.excludeThreadId !== null;
    return this.searchFallbackByScope({
      limit: input.limit,
      query: input.query,
      whereClause: hasExclude ? "thread_id != ?" : "1=1",
      whereParams: hasExclude ? [input.excludeThreadId as string] : []
    });
  }

  private searchFallbackByScope(input: {
    limit: number;
    query: string;
    whereClause: string;
      whereParams: SqlParameter[];
  }): SessionIndexRow[] {
    const pattern = `%${input.query.trim().replace(/\s+/gu, "%")}%`;
    return this.database
      .prepare(
        `SELECT
          session_memory_id,
          thread_id,
          summary,
          goal,
          decisions,
          open_loops,
          next_actions,
          created_at,
          CASE
            WHEN summary LIKE ? THEN 0.2
            WHEN goal LIKE ? THEN 0.4
            WHEN keywords LIKE ? THEN 0.6
            ELSE 1
          END AS score
        FROM session_index
        WHERE ${input.whereClause}
          AND (
            summary LIKE ?
            OR goal LIKE ?
            OR decisions LIKE ?
            OR open_loops LIKE ?
            OR next_actions LIKE ?
            OR keywords LIKE ?
          )
        ORDER BY score ASC, created_at DESC
        LIMIT ?`
      )
      .all(
        pattern,
        pattern,
        pattern,
        ...input.whereParams,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        input.limit
      ) as unknown as SessionIndexRow[];
  }

  private mapSearchRow(row: SessionIndexRow): SessionSearchHit {
    return {
      createdAt: row.created_at,
      decisions: splitLines(row.decisions),
      goal: row.goal,
      nextActions: splitLines(row.next_actions),
      openLoops: splitLines(row.open_loops),
      score: row.score,
      sessionMemoryId: row.session_memory_id,
      summary: row.summary,
      threadId: row.thread_id
    };
  }

  private mapRow(row: ThreadSessionMemoryEventRow): ThreadSessionMemoryRecord {
    return {
      createdAt: row.created_at,
      decisions: parseJsonValue<string[]>(row.decisions_json),
      goal: row.goal,
      metadata: parseJsonValue<JsonObject>(row.metadata_json),
      nextActions: parseJsonValue<string[]>(row.next_actions_json),
      openLoops: parseJsonValue<string[]>(row.open_loops_json),
      runId: row.run_id,
      sessionMemoryId: row.session_memory_id,
      summary: row.summary,
      taskId: row.task_id,
      threadId: row.thread_id,
      trigger: row.trigger
    };
  }
}

function splitLines(value: string): string[] {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function uniqueTokens(values: string[]): string[] {
  return [...new Set(values.join(" ").toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean))];
}
