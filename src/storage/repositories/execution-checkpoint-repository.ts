import type { DatabaseSync } from "node:sqlite";

import type {
  ConversationMessage,
  ContextFragment,
  ExecutionCheckpointRecord,
  ExecutionCheckpointRepository,
  ProviderToolCall
} from "../../types/index.js";

import { parseJsonValue, serializeJsonValue } from "./json.js";

interface ExecutionCheckpointRow {
  task_id: string;
  iteration: number;
  memory_context_json: string;
  messages_json: string;
  pending_tool_calls_json: string;
  updated_at: string;
}

export class SqliteExecutionCheckpointRepository implements ExecutionCheckpointRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public save(record: ExecutionCheckpointRecord): ExecutionCheckpointRecord {
    this.database
      .prepare(
        `
          INSERT INTO execution_checkpoints (
            task_id,
            iteration,
            memory_context_json,
            messages_json,
            pending_tool_calls_json,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET
            iteration = excluded.iteration,
            memory_context_json = excluded.memory_context_json,
            messages_json = excluded.messages_json,
            pending_tool_calls_json = excluded.pending_tool_calls_json,
            updated_at = excluded.updated_at
        `
      )
      .run(
        record.taskId,
        record.iteration,
        serializeJsonValue(record.memoryContext),
        serializeJsonValue(record.messages),
        serializeJsonValue(record.pendingToolCalls),
        record.updatedAt
      );

    const saved = this.findByTaskId(record.taskId);
    if (saved === null) {
      throw new Error(`Execution checkpoint for task ${record.taskId} was not persisted.`);
    }

    return saved;
  }

  public findByTaskId(taskId: string): ExecutionCheckpointRecord | null {
    const row = this.database
      .prepare("SELECT * FROM execution_checkpoints WHERE task_id = ?")
      .get(taskId) as ExecutionCheckpointRow | undefined;

    if (row === undefined) {
      return null;
    }

    return {
      iteration: row.iteration,
      memoryContext: parseJsonValue<ContextFragment[]>(row.memory_context_json),
      messages: parseJsonValue<ConversationMessage[]>(row.messages_json),
      pendingToolCalls: parseJsonValue<ProviderToolCall[]>(row.pending_tool_calls_json),
      taskId: row.task_id,
      updatedAt: row.updated_at
    };
  }

  public delete(taskId: string): void {
    this.database.prepare("DELETE FROM execution_checkpoints WHERE task_id = ?").run(taskId);
  }
}
