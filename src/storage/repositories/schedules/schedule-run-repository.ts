import type { DatabaseSync } from "node:sqlite";

import { ACTIVE_SCHEDULE_RUN_STATUSES, SCHEDULE_RUN_STATUS_TRANSITIONS } from "../../../types/schedule.js";
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

const ACTIVE_RUN_STATUS_SQL = ACTIVE_SCHEDULE_RUN_STATUSES.map(() => "?").join(", ");

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
  session_id: string | null;
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
          task_id, session_id, error_code, error_message, trigger, metadata_json
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
        record.sessionId ?? null,
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

  public list(query?: ScheduleRunListQuery): ScheduleRunRecord[] {
    const where: string[] = [];
    const params: string[] = [];
    if (query?.status !== undefined) {
      where.push("status = ?");
      params.push(query.status);
    }
    const tail = query?.tail ?? 500;
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.database
      .prepare(
        `SELECT * FROM schedule_runs
         ${whereSql}
         ORDER BY scheduled_at DESC, run_id DESC
         LIMIT ?`
      )
      .all(...params, tail) as unknown as ScheduleRunRow[];
    return rows.map((row) => this.mapRow(row));
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

  public listBySessionId(sessionId: string): ScheduleRunRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM schedule_runs WHERE session_id = ? ORDER BY scheduled_at DESC, run_id DESC")
      .all(sessionId) as unknown as ScheduleRunRow[];
    return rows.map((row) => this.mapRow(row));
  }

  public findActiveByScheduleId(scheduleId: string): ScheduleRunRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM schedule_runs
         WHERE schedule_id = ? AND status IN (${ACTIVE_RUN_STATUS_SQL})
         ORDER BY scheduled_at DESC, run_id DESC
         LIMIT 1`
      )
      .get(scheduleId, ...ACTIVE_SCHEDULE_RUN_STATUSES) as ScheduleRunRow | undefined;
    return row === undefined ? null : this.mapRow(row);
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
    if (patch.status !== undefined && patch.status !== existing.status) {
      const allowed = SCHEDULE_RUN_STATUS_TRANSITIONS[existing.status];
      if (!allowed.includes(patch.status)) {
        throw new Error(`Invalid schedule run transition: ${existing.status} -> ${patch.status}.`);
      }
    }

    const next: ScheduleRunRecord = {
      ...existing,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.scheduledAt !== undefined ? { scheduledAt: patch.scheduledAt } : {}),
      ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
      ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {}),
      ...(patch.taskId !== undefined ? { taskId: patch.taskId } : {}),
      ...(patch.sessionId !== undefined ? { sessionId: patch.sessionId } : {}),
      ...(patch.errorCode !== undefined ? { errorCode: patch.errorCode } : {}),
      ...(patch.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
      ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {})
    };
    this.database
      .prepare(
        `UPDATE schedule_runs
         SET status = ?, scheduled_at = ?, started_at = ?, finished_at = ?, task_id = ?, session_id = ?, error_code = ?,
             error_message = ?, metadata_json = ?
         WHERE run_id = ?`
      )
      .run(
        next.status,
        next.scheduledAt,
        next.startedAt,
        next.finishedAt,
        next.taskId,
        next.sessionId,
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
      sessionId: row.session_id,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      trigger: row.trigger,
      metadata: parseJsonValue<JsonObject>(row.metadata_json)
    };
  }
}
