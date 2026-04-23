import type { DatabaseSync } from "node:sqlite";

import type { TraceEvent, TraceRepository } from "../../types/index.js";

import { parseJsonValue, serializeJsonValue } from "./json.js";

interface TraceRow {
  actor: string;
  event_id: string;
  event_type: TraceEvent["eventType"];
  payload_json: string;
  sequence: number;
  stage: TraceEvent["stage"];
  summary: string;
  task_id: string;
  timestamp: string;
}

export class SqliteTraceRepository implements TraceRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public append(event: Omit<TraceEvent, "sequence">): TraceEvent {
    const timestamp = event.timestamp;
    this.database
      .prepare(
        `
          INSERT INTO traces (
            event_id,
            task_id,
            timestamp,
            event_type,
            stage,
            actor,
            summary,
            payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        event.eventId,
        event.taskId,
        timestamp,
        event.eventType,
        event.stage,
        event.actor,
        event.summary,
        serializeJsonValue(event.payload)
      );

    const row = this.database
      .prepare("SELECT * FROM traces WHERE event_id = ?")
      .get(event.eventId) as TraceRow | undefined;

    if (row === undefined) {
      throw new Error(`Trace event ${event.eventId} was not persisted.`);
    }

    return this.mapRow(row);
  }

  public listByTaskId(taskId: string): TraceEvent[] {
    const rows = this.database
      .prepare("SELECT * FROM traces WHERE task_id = ? ORDER BY sequence ASC")
      .all(taskId) as unknown as TraceRow[];

    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: TraceRow): TraceEvent {
    return {
      actor: row.actor,
      eventId: row.event_id,
      eventType: row.event_type,
      payload: parseJsonValue<TraceEvent["payload"]>(row.payload_json),
      sequence: row.sequence,
      stage: row.stage,
      summary: row.summary,
      taskId: row.task_id,
      timestamp: row.timestamp
    } as TraceEvent;
  }
}
