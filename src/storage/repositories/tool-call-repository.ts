import type { DatabaseSync } from "node:sqlite";

import type {
  JsonObject,
  JsonValue,
  ToolCallRecord,
  ToolCallRepository
} from "../../types/index.js";
import { canTransitionToolCallStatus } from "../../types/index.js";

import { parseJsonValue, serializeJsonValue } from "./json.js";

interface ToolCallRow {
  error_code: ToolCallRecord["errorCode"];
  error_message: string | null;
  finished_at: string | null;
  input_json: string;
  iteration: number;
  output_json: string | null;
  requested_at: string;
  risk_level: ToolCallRecord["riskLevel"];
  started_at: string | null;
  status: ToolCallRecord["status"];
  summary: string | null;
  task_id: string;
  tool_call_id: string;
  tool_name: string;
}

export class SqliteToolCallRepository implements ToolCallRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(record: ToolCallRecord): ToolCallRecord {
    this.database
      .prepare(
        `
          INSERT INTO tool_calls (
            tool_call_id,
            task_id,
            iteration,
            tool_name,
            risk_level,
            status,
            input_json,
            output_json,
            summary,
            requested_at,
            started_at,
            finished_at,
            error_code,
            error_message
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        record.toolCallId,
        record.taskId,
        record.iteration,
        record.toolName,
        record.riskLevel,
        record.status,
        serializeJsonValue(record.input),
        record.output === null ? null : serializeJsonValue(record.output),
        record.summary,
        record.requestedAt,
        record.startedAt,
        record.finishedAt,
        record.errorCode,
        record.errorMessage
      );

    return this.getById(record.toolCallId);
  }

  public findById(toolCallId: string): ToolCallRecord | null {
    const row = this.database
      .prepare("SELECT * FROM tool_calls WHERE tool_call_id = ?")
      .get(toolCallId) as ToolCallRow | undefined;

    return row === undefined ? null : this.mapRow(row);
  }

  public update(toolCallId: string, patch: Partial<ToolCallRecord>): ToolCallRecord {
    const existing = this.getById(toolCallId);

    const nextRecord: ToolCallRecord = {
      ...existing,
      errorCode: patch.errorCode === undefined ? existing.errorCode : patch.errorCode,
      errorMessage:
        patch.errorMessage === undefined ? existing.errorMessage : patch.errorMessage,
      finishedAt:
        patch.finishedAt === undefined ? existing.finishedAt : patch.finishedAt,
      input: patch.input ?? existing.input,
      output: patch.output === undefined ? existing.output : patch.output,
      requestedAt: patch.requestedAt ?? existing.requestedAt,
      riskLevel: patch.riskLevel ?? existing.riskLevel,
      startedAt: patch.startedAt === undefined ? existing.startedAt : patch.startedAt,
      status: patch.status ?? existing.status,
      summary: patch.summary === undefined ? existing.summary : patch.summary,
      taskId: patch.taskId ?? existing.taskId,
      toolCallId: patch.toolCallId ?? existing.toolCallId,
      toolName: patch.toolName ?? existing.toolName,
      iteration: patch.iteration ?? existing.iteration
    };

    if (
      nextRecord.status !== existing.status &&
      !canTransitionToolCallStatus(existing.status, nextRecord.status)
    ) {
      throw new Error(
        `Illegal tool-call status transition: ${existing.status} -> ${nextRecord.status}`
      );
    }

    this.database
      .prepare(
        `
          UPDATE tool_calls
          SET task_id = ?,
              iteration = ?,
              tool_name = ?,
              risk_level = ?,
              status = ?,
              input_json = ?,
              output_json = ?,
              summary = ?,
              requested_at = ?,
              started_at = ?,
              finished_at = ?,
              error_code = ?,
              error_message = ?
          WHERE tool_call_id = ?
        `
      )
      .run(
        nextRecord.taskId,
        nextRecord.iteration,
        nextRecord.toolName,
        nextRecord.riskLevel,
        nextRecord.status,
        serializeJsonValue(nextRecord.input),
        nextRecord.output === null ? null : serializeJsonValue(nextRecord.output),
        nextRecord.summary,
        nextRecord.requestedAt,
        nextRecord.startedAt,
        nextRecord.finishedAt,
        nextRecord.errorCode,
        nextRecord.errorMessage,
        toolCallId
      );

    return this.getById(toolCallId);
  }

  public listByTaskId(taskId: string): ToolCallRecord[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM tool_calls WHERE task_id = ? ORDER BY requested_at ASC, tool_call_id ASC"
      )
      .all(taskId) as unknown as ToolCallRow[];

    return rows.map((row) => this.mapRow(row));
  }

  private getById(toolCallId: string): ToolCallRecord {
    const row = this.findById(toolCallId);

    if (row === null) {
      throw new Error(`Tool call ${toolCallId} was not found.`);
    }

    return row;
  }

  private mapRow(row: ToolCallRow): ToolCallRecord {
    return {
      errorCode: row.error_code,
      errorMessage: row.error_message,
      finishedAt: row.finished_at,
      input: parseJsonValue<JsonObject>(row.input_json),
      iteration: row.iteration,
      output:
        row.output_json === null ? null : parseJsonValue<JsonValue>(row.output_json),
      requestedAt: row.requested_at,
      riskLevel: row.risk_level,
      startedAt: row.started_at,
      status: row.status,
      summary: row.summary,
      taskId: row.task_id,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name
    };
  }
}
