import type { DatabaseSync } from "node:sqlite";

import type { JsonObject, ThreadRunDraft, ThreadRunRecord, ThreadRunRepository } from "../../types/index.js";

import { parseJsonValue, serializeJsonValue } from "./json.js";

interface ThreadRunRow {
  run_id: string;
  thread_id: string;
  task_id: string;
  run_number: number;
  input: string;
  status: ThreadRunRecord["status"];
  created_at: string;
  finished_at: string | null;
  summary_json: string;
  metadata_json: string;
}

export class SqliteThreadRunRepository implements ThreadRunRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(record: ThreadRunDraft): ThreadRunRecord {
    const latest = this.findLatestByThreadId(record.threadId);
    const runNumber = latest === null ? 1 : latest.runNumber + 1;
    const createdAt = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO thread_runs (
          run_id, thread_id, task_id, run_number, input, status, created_at, finished_at, summary_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.runId,
        record.threadId,
        record.taskId,
        runNumber,
        record.input,
        record.status,
        createdAt,
        record.finishedAt ?? null,
        serializeJsonValue(record.summary ?? {}),
        serializeJsonValue(record.metadata ?? {})
      );
    const created = this.findByTaskId(record.taskId);
    if (created === null) {
      throw new Error(`Thread run for task ${record.taskId} was not persisted.`);
    }
    return created;
  }

  public findByTaskId(taskId: string): ThreadRunRecord | null {
    const row = this.database
      .prepare("SELECT * FROM thread_runs WHERE task_id = ?")
      .get(taskId) as ThreadRunRow | undefined;
    return row === undefined ? null : this.mapRow(row);
  }

  public listByThreadId(threadId: string): ThreadRunRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM thread_runs WHERE thread_id = ? ORDER BY run_number ASC")
      .all(threadId) as unknown as ThreadRunRow[];
    return rows.map((row) => this.mapRow(row));
  }

  public findLatestByThreadId(threadId: string): ThreadRunRecord | null {
    const row = this.database
      .prepare("SELECT * FROM thread_runs WHERE thread_id = ? ORDER BY run_number DESC LIMIT 1")
      .get(threadId) as ThreadRunRow | undefined;
    return row === undefined ? null : this.mapRow(row);
  }

  private mapRow(row: ThreadRunRow): ThreadRunRecord {
    return {
      runId: row.run_id,
      threadId: row.thread_id,
      taskId: row.task_id,
      runNumber: row.run_number,
      input: row.input,
      status: row.status,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
      summary: parseJsonValue<JsonObject>(row.summary_json),
      metadata: parseJsonValue<JsonObject>(row.metadata_json)
    };
  }
}
