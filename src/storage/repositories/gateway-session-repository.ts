import type { DatabaseSync } from "node:sqlite";

import type {
  GatewaySessionBinding,
  GatewaySessionBindingDraft,
  GatewaySessionRepository,
  JsonObject
} from "../../types";

import { parseJsonValue, serializeJsonValue } from "./json";

interface GatewaySessionBindingRow {
  adapter_id: string;
  created_at: string;
  external_session_id: string;
  external_user_id: string | null;
  metadata_json: string;
  runtime_user_id: string;
  session_binding_id: string;
  task_id: string;
  updated_at: string;
}

export class SqliteGatewaySessionRepository implements GatewaySessionRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(record: GatewaySessionBindingDraft): GatewaySessionBinding {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `
          INSERT INTO gateway_session_bindings (
            session_binding_id,
            adapter_id,
            external_session_id,
            external_user_id,
            runtime_user_id,
            task_id,
            created_at,
            updated_at,
            metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        record.sessionBindingId,
        record.adapterId,
        record.externalSessionId,
        record.externalUserId,
        record.runtimeUserId,
        record.taskId,
        now,
        now,
        serializeJsonValue(record.metadata)
      );

    const created = this.findByTaskId(record.taskId);
    if (created === null) {
      throw new Error(`Gateway session binding for task ${record.taskId} was not persisted.`);
    }

    return created;
  }

  public findByTaskId(taskId: string): GatewaySessionBinding | null {
    const row = this.database
      .prepare("SELECT * FROM gateway_session_bindings WHERE task_id = ?")
      .get(taskId) as GatewaySessionBindingRow | undefined;

    return row === undefined ? null : this.mapRow(row);
  }

  public findLatestByExternalSession(
    adapterId: string,
    externalSessionId: string
  ): GatewaySessionBinding | null {
    const row = this.database
      .prepare(
        `
          SELECT * FROM gateway_session_bindings
          WHERE adapter_id = ? AND external_session_id = ?
          ORDER BY created_at DESC
          LIMIT 1
        `
      )
      .get(adapterId, externalSessionId) as GatewaySessionBindingRow | undefined;

    return row === undefined ? null : this.mapRow(row);
  }

  public listByExternalSession(
    adapterId: string,
    externalSessionId: string
  ): GatewaySessionBinding[] {
    const rows = this.database
      .prepare(
        `
          SELECT * FROM gateway_session_bindings
          WHERE adapter_id = ? AND external_session_id = ?
          ORDER BY created_at DESC
        `
      )
      .all(adapterId, externalSessionId) as unknown as GatewaySessionBindingRow[];

    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: GatewaySessionBindingRow): GatewaySessionBinding {
    return {
      adapterId: row.adapter_id,
      createdAt: row.created_at,
      externalSessionId: row.external_session_id,
      externalUserId: row.external_user_id,
      metadata: parseJsonValue<JsonObject>(row.metadata_json),
      runtimeUserId: row.runtime_user_id,
      sessionBindingId: row.session_binding_id,
      taskId: row.task_id,
      updatedAt: row.updated_at
    };
  }
}
