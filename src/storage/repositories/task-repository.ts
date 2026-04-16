import type { DatabaseSync } from "node:sqlite";

import type {
  JsonObject,
  TaskDraft,
  TaskRecord,
  TaskRepository,
  TaskUpdatePatch,
  TokenBudget
} from "../../types";
import { canTransitionTaskStatus } from "../../types";

import { parseJsonValue, serializeJsonValue } from "./json";

interface TaskRow {
  task_id: string;
  input: string;
  status: TaskRecord["status"];
  cwd: string;
  provider_name: string;
  current_iteration: number;
  max_iterations: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  final_output: string | null;
  error_code: TaskRecord["errorCode"];
  error_message: string | null;
  token_budget_json: string;
  metadata_json: string;
}

export class SqliteTaskRepository implements TaskRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(task: TaskDraft): TaskRecord {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `
          INSERT INTO tasks (
            task_id,
            input,
            status,
            cwd,
            provider_name,
            current_iteration,
            max_iterations,
            created_at,
            updated_at,
            started_at,
            finished_at,
            final_output,
            error_code,
            error_message,
            token_budget_json,
            metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        task.taskId,
        task.input,
        "pending",
        task.cwd,
        task.providerName,
        0,
        task.maxIterations,
        now,
        now,
        null,
        null,
        null,
        null,
        null,
        serializeJsonValue(task.tokenBudget),
        serializeJsonValue(task.metadata ?? {})
      );

    const createdTask = this.findById(task.taskId);
    if (createdTask === null) {
      throw new Error(`Task ${task.taskId} was not persisted.`);
    }

    return createdTask;
  }

  public findById(taskId: string): TaskRecord | null {
    const row = this.database
      .prepare("SELECT * FROM tasks WHERE task_id = ?")
      .get(taskId) as TaskRow | undefined;

    return row === undefined ? null : this.mapRow(row);
  }

  public list(): TaskRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM tasks ORDER BY created_at DESC")
      .all() as unknown as TaskRow[];

    return rows.map((row) => this.mapRow(row));
  }

  public update(taskId: string, patch: TaskUpdatePatch): TaskRecord {
    const existing = this.findById(taskId);
    if (existing === null) {
      throw new Error(`Task ${taskId} was not found.`);
    }

    if (
      patch.status !== undefined &&
      !canTransitionTaskStatus(existing.status, patch.status) &&
      existing.status !== patch.status
    ) {
      throw new Error(`Illegal task status transition: ${existing.status} -> ${patch.status}`);
    }

    const nextTask: TaskRecord = {
      ...existing,
      currentIteration: patch.currentIteration ?? existing.currentIteration,
      errorCode:
        patch.errorCode === undefined ? existing.errorCode : patch.errorCode,
      errorMessage:
        patch.errorMessage === undefined ? existing.errorMessage : patch.errorMessage,
      finalOutput:
        patch.finalOutput === undefined ? existing.finalOutput : patch.finalOutput,
      finishedAt:
        patch.finishedAt === undefined ? existing.finishedAt : patch.finishedAt,
      startedAt: patch.startedAt === undefined ? existing.startedAt : patch.startedAt,
      status: patch.status ?? existing.status,
      updatedAt: new Date().toISOString()
    };

    this.database
      .prepare(
        `
          UPDATE tasks
          SET status = ?,
              current_iteration = ?,
              updated_at = ?,
              started_at = ?,
              finished_at = ?,
              final_output = ?,
              error_code = ?,
              error_message = ?
          WHERE task_id = ?
        `
      )
      .run(
        nextTask.status,
        nextTask.currentIteration,
        nextTask.updatedAt,
        nextTask.startedAt,
        nextTask.finishedAt,
        nextTask.finalOutput,
        nextTask.errorCode,
        nextTask.errorMessage,
        taskId
      );

    return nextTask;
  }

  private mapRow(row: TaskRow): TaskRecord {
    return {
      createdAt: row.created_at,
      currentIteration: row.current_iteration,
      cwd: row.cwd,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      finalOutput: row.final_output,
      finishedAt: row.finished_at,
      input: row.input,
      maxIterations: row.max_iterations,
      metadata: parseJsonValue<JsonObject>(row.metadata_json),
      providerName: row.provider_name,
      startedAt: row.started_at,
      status: row.status,
      taskId: row.task_id,
      tokenBudget: parseJsonValue<TokenBudget>(row.token_budget_json),
      updatedAt: row.updated_at
    };
  }
}
