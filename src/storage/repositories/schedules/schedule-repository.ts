import type { DatabaseSync } from "node:sqlite";

import type {
  JsonObject,
  ScheduleDraft,
  ScheduleDueQuery,
  ScheduleListQuery,
  ScheduleRecord,
  ScheduleRepository,
  ScheduleStatus,
  ScheduleUpdatePatch
} from "../../../types/index.js";

import { parseJsonValue, serializeJsonValue } from "../json.js";

interface ScheduleRow {
  schedule_id: string;
  name: string;
  status: ScheduleStatus;
  thread_id: string | null;
  owner_user_id: string;
  cwd: string;
  agent_profile_id: string;
  provider_name: string;
  input: string;
  run_at: string | null;
  interval_ms: number | null;
  cron: string | null;
  timezone: string | null;
  max_attempts: number;
  backoff_base_ms: number;
  backoff_max_ms: number;
  next_fire_at: string | null;
  last_fire_at: string | null;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export class SqliteScheduleRepository implements ScheduleRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(record: ScheduleDraft): ScheduleRecord {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO schedules (
          schedule_id, name, status, thread_id, owner_user_id, cwd, agent_profile_id, provider_name,
          input, run_at, interval_ms, cron, timezone, max_attempts, backoff_base_ms, backoff_max_ms,
          next_fire_at, last_fire_at, created_at, updated_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.scheduleId,
        record.name,
        "active",
        record.threadId ?? null,
        record.ownerUserId,
        record.cwd,
        record.agentProfileId,
        record.providerName,
        record.input,
        record.runAt ?? null,
        record.intervalMs ?? null,
        record.cron ?? null,
        record.timezone ?? null,
        record.maxAttempts ?? 3,
        record.backoffBaseMs ?? 5_000,
        record.backoffMaxMs ?? 300_000,
        record.nextFireAt ?? null,
        record.lastFireAt ?? null,
        now,
        now,
        serializeJsonValue(record.metadata ?? {})
      );
    const created = this.findById(record.scheduleId);
    if (created === null) {
      throw new Error(`Schedule ${record.scheduleId} was not persisted.`);
    }
    return created;
  }

  public findById(scheduleId: string): ScheduleRecord | null {
    const row = this.database
      .prepare("SELECT * FROM schedules WHERE schedule_id = ?")
      .get(scheduleId) as ScheduleRow | undefined;
    return row === undefined ? null : this.mapRow(row);
  }

  public list(query?: ScheduleListQuery): ScheduleRecord[] {
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
      .prepare(`SELECT * FROM schedules ${whereSql} ORDER BY updated_at DESC`)
      .all(...params) as unknown as ScheduleRow[];
    return rows.map((row) => this.mapRow(row));
  }

  public update(scheduleId: string, patch: ScheduleUpdatePatch): ScheduleRecord {
    const existing = this.findById(scheduleId);
    if (existing === null) {
      throw new Error(`Schedule ${scheduleId} was not found.`);
    }
    const next: ScheduleRecord = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.threadId !== undefined ? { threadId: patch.threadId } : {}),
      ...(patch.input !== undefined ? { input: patch.input } : {}),
      ...(patch.runAt !== undefined ? { runAt: patch.runAt } : {}),
      ...(patch.intervalMs !== undefined ? { intervalMs: patch.intervalMs } : {}),
      ...(patch.cron !== undefined ? { cron: patch.cron } : {}),
      ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      ...(patch.maxAttempts !== undefined ? { maxAttempts: patch.maxAttempts } : {}),
      ...(patch.backoffBaseMs !== undefined ? { backoffBaseMs: patch.backoffBaseMs } : {}),
      ...(patch.backoffMaxMs !== undefined ? { backoffMaxMs: patch.backoffMaxMs } : {}),
      ...(patch.nextFireAt !== undefined ? { nextFireAt: patch.nextFireAt } : {}),
      ...(patch.lastFireAt !== undefined ? { lastFireAt: patch.lastFireAt } : {}),
      ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
      updatedAt: new Date().toISOString()
    };

    this.database
      .prepare(
        `UPDATE schedules
         SET name = ?, status = ?, thread_id = ?, input = ?, run_at = ?, interval_ms = ?, cron = ?,
             timezone = ?, max_attempts = ?, backoff_base_ms = ?, backoff_max_ms = ?, next_fire_at = ?,
             last_fire_at = ?, updated_at = ?, metadata_json = ?
         WHERE schedule_id = ?`
      )
      .run(
        next.name,
        next.status,
        next.threadId,
        next.input,
        next.runAt,
        next.intervalMs,
        next.cron,
        next.timezone,
        next.maxAttempts,
        next.backoffBaseMs,
        next.backoffMaxMs,
        next.nextFireAt,
        next.lastFireAt,
        next.updatedAt,
        serializeJsonValue(next.metadata),
        scheduleId
      );
    return next;
  }

  public findDue(query: ScheduleDueQuery): ScheduleRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM schedules
         WHERE status = 'active' AND next_fire_at IS NOT NULL AND next_fire_at <= ?
         ORDER BY next_fire_at ASC
         LIMIT ?`
      )
      .all(query.now, query.limit ?? 25) as unknown as ScheduleRow[];
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: ScheduleRow): ScheduleRecord {
    return {
      scheduleId: row.schedule_id,
      name: row.name,
      status: row.status,
      threadId: row.thread_id,
      ownerUserId: row.owner_user_id,
      cwd: row.cwd,
      agentProfileId: row.agent_profile_id as ScheduleRecord["agentProfileId"],
      providerName: row.provider_name,
      input: row.input,
      runAt: row.run_at,
      intervalMs: row.interval_ms,
      cron: row.cron,
      timezone: row.timezone,
      maxAttempts: row.max_attempts,
      backoffBaseMs: row.backoff_base_ms,
      backoffMaxMs: row.backoff_max_ms,
      nextFireAt: row.next_fire_at,
      lastFireAt: row.last_fire_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metadata: parseJsonValue<JsonObject>(row.metadata_json)
    };
  }
}
