import type { DatabaseSync } from "node:sqlite";

import type { JsonObject, RunMetadataRecord, RunMetadataRepository, TokenBudget } from "../../types";

import { parseJsonValue, serializeJsonValue } from "./json";

interface RunMetadataRow {
  created_at: string;
  metadata_json: string;
  provider_name: string;
  run_metadata_id: string;
  runtime_version: string;
  task_id: string;
  timeout_ms: number;
  token_budget_json: string;
  workspace_root: string;
}

export class SqliteRunMetadataRepository implements RunMetadataRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(record: RunMetadataRecord): RunMetadataRecord {
    this.database
      .prepare(
        `
          INSERT INTO run_metadata (
            run_metadata_id,
            task_id,
            runtime_version,
            provider_name,
            workspace_root,
            timeout_ms,
            created_at,
            token_budget_json,
            metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        record.runMetadataId,
        record.taskId,
        record.runtimeVersion,
        record.providerName,
        record.workspaceRoot,
        record.timeoutMs,
        record.createdAt,
        serializeJsonValue(record.tokenBudget),
        serializeJsonValue(record.metadata)
      );

    const created = this.findByTaskId(record.taskId);
    if (created === null) {
      throw new Error(`Run metadata for task ${record.taskId} was not persisted.`);
    }

    return created;
  }

  public findByTaskId(taskId: string): RunMetadataRecord | null {
    const row = this.database
      .prepare("SELECT * FROM run_metadata WHERE task_id = ?")
      .get(taskId) as RunMetadataRow | undefined;

    if (row === undefined) {
      return null;
    }

    return {
      createdAt: row.created_at,
      metadata: parseJsonValue<JsonObject>(row.metadata_json),
      providerName: row.provider_name,
      runMetadataId: row.run_metadata_id,
      runtimeVersion: row.runtime_version,
      taskId: row.task_id,
      timeoutMs: row.timeout_ms,
      tokenBudget: parseJsonValue<TokenBudget>(row.token_budget_json),
      workspaceRoot: row.workspace_root
    };
  }
}
