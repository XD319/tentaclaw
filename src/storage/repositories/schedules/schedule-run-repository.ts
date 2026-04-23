import type { DatabaseSync } from "node:sqlite";

import type {
  JsonObject,
  ScheduleRunDraft,
  ScheduleRunListQuery,
  ScheduleRunRecord,
  ScheduleRunRepository,
  ScheduleRunStatus,
  ScheduleRunTrigger,
  ScheduleRunUpdatePatch
} from "../../../types/index.js";

import { parseJsonValue, serializeJsonValue } from "../json.js";

interface ScheduleRunRow {
  run_id: string;
  schedule_id: string;
  attempt_number: number;
  status: ScheduleRunStatus;
  scheduled_at: string;
  started_at: string | null;
  finished_at: string | null;
  task_id: string | null;
  thread_id: string | null;
  error_code: string | null;
  error_message: string | null;
  trigger: ScheduleRunTrigger;
  metadata_json: string;
}

export class SqliteScheduleRunRepository implements ScheduleRunRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(record: ScheduleRunDraft): ScheduleRunRecord {
    this.database
      .prepare(
        `INSERT INTO schedule_runs (
          run_id, schedule_id, attempt_number, status, scheduled_at, started_at, finished_at,
          task_id, thread_id, error_code, error_message, trigger, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.runId,
        record.scheduleId,
        record.attemptNumber,
        record.status,
        record.scheduledAt,
        record.startedAt ?? null,
        record.finishedAt ?? null,
        record.taskId ?? null,
        record.threadId ?? null,
        record.errorCode ?? null,
        record.errorMessage ?? null,
        record.trigger,
        serializeJsonValue(record.metadata ?? {})
      );
    const created = this.findById(record.runId);
    if (created === null) {
      throw new Error(`Schedule run ${record.runId} was not persisted.`);
    }
    return created;
  }

  public findById(runId: string): ScheduleRunRecord | null {
    const row = this.database
      .prepare("SELECT * FROM schedule_runs WHERE run_id = ?")
      .get(runId) as ScheduleRunRow | undefined;
    return row === undefined ? null : this.mapRow(row);
  }

  public listByScheduleId(scheduleId: string, query?: ScheduleRunListQuery): ScheduleRunRecord[] {
    const where: string[] = ["schedule_id = ?"];
    const params: string[] = [scheduleId];
    if (query?.status !== undefined) {
      where.push("status = ?");
      params.push(query.status);
    }
    const tail = query?.tail ?? 100;
    const rows = this.database
      .prepare(
        `SELECT * FROM schedule_runs
         WHERE ${where.join(" AND ")}
         ORDER BY scheduled_at DESC, run_id DESC
         LIMIT ?`
      )
      .all(...params, tail) as unknown as ScheduleRunRow[];
    return rows.map((row) => this.mapRow(row));
  }

  public listByTaskId(taskId: string): ScheduleRunRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM schedule_runs WHERE task_id = ? ORDER BY scheduled_at DESC, run_id DESC")
      .all(taskId) as unknown as ScheduleRunRow[];
    return rows.map((row) => this.mapRow(row));
  }

  public listByThreadId(threadId: string): ScheduleRunRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM schedule_runs WHERE thread_id = ? ORDER BY scheduled_at DESC, run_id DESC")
      .all(threadId) as unknown as ScheduleRunRow[];
    return rows.map((row) => this.mapRow(row));
  }

  public claimDue(now: string, limit: number): ScheduleRunRecord[] {
    const rows = this.database
      .prepare(
        `SELECT run_id FROM schedule_runs
         WHERE status = 'queued' AND scheduled_at <= ?
         ORDER BY scheduled_at ASC, run_id ASC
         LIMIT ?`
      )
      .all(now, limit) as Array<{ run_id: string }>;
    if (rows.length === 0) {
      return [];
    }

    const claimed: ScheduleRunRecord[] = [];
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const result = this.database
          .prepare("UPDATE schedule_runs SET status = 'running', started_at = ? WHERE run_id = ? AND status = 'queued'")
          .run(now, row.run_id);
        if (result.changes === 0) {
          continue;
        }
        const record = this.findById(row.run_id);
        if (record !== null) {
          claimed.push(record);
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return claimed;
  }

  public update(runId: string, patch: ScheduleRunUpdatePatch): ScheduleRunRecord {
    const existing = this.findById(runId);
    if (existing === null) {
      throw new Error(`Schedule run ${runId} was not found.`);
    }

    const next: ScheduleRunRecord = {
      ...existing,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
      ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {}),
      ...(patch.taskId !== undefined ? { taskId: patch.taskId } : {}),
      ...(patch.threadId !== undefined ? { threadId: patch.threadId } : {}),
      ...(patch.errorCode !== undefined ? { errorCode: patch.errorCode } : {}),
      ...(patch.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
      ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {})
    };
    this.database
      .prepare(
        `UPDATE schedule_runs
         SET status = ?, started_at = ?, finished_at = ?, task_id = ?, thread_id = ?, error_code = ?,
             error_message = ?, metadata_json = ?
         WHERE run_id = ?`
      )
      .run(
        next.status,
        next.startedAt,
        next.finishedAt,
        next.taskId,
        next.threadId,
        next.errorCode,
        next.errorMessage,
        serializeJsonValue(next.metadata),
        runId
      );
    return next;
  }

  private mapRow(row: ScheduleRunRow): ScheduleRunRecord {
    return {
      runId: row.run_id,
      scheduleId: row.schedule_id,
      attemptNumber: row.attempt_number,
      status: row.status,
      scheduledAt: row.scheduled_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      taskId: row.task_id,
      threadId: row.thread_id,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      trigger: row.trigger,
      metadata: parseJsonValue<JsonObject>(row.metadata_json)
    };
  }
}
