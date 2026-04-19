import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { ArtifactDraft, ArtifactRecord, ArtifactRepository, JsonValue } from "../../types";

import { parseJsonValue, serializeJsonValue } from "./json";

interface ArtifactRow {
  artifact_id: string;
  artifact_type: string;
  content_json: string;
  created_at: string;
  task_id: string;
  tool_call_id: string | null;
  uri: string;
}

export class SqliteArtifactRepository implements ArtifactRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public createMany(
    taskId: string,
    toolCallId: string | null,
    artifacts: ArtifactDraft[]
  ): ArtifactRecord[] {
    if (artifacts.length === 0) {
      return [];
    }

    const statement = this.database.prepare(
      `
        INSERT INTO artifacts (
          artifact_id,
          task_id,
          tool_call_id,
          artifact_type,
          uri,
          content_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    );

    const createdAt = new Date().toISOString();

    for (const artifact of artifacts) {
      statement.run(
        randomUUID(),
        taskId,
        toolCallId,
        artifact.artifactType,
        artifact.uri,
        serializeJsonValue(artifact.content),
        createdAt
      );
    }

    return this.listByTaskId(taskId);
  }

  public listByTaskId(taskId: string): ArtifactRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId) as unknown as ArtifactRow[];

    return rows.map((row) => ({
      artifactId: row.artifact_id,
      artifactType: row.artifact_type,
      content: parseJsonValue<JsonValue>(row.content_json),
      createdAt: row.created_at,
      taskId: row.task_id,
      toolCallId: row.tool_call_id,
      uri: row.uri
    }));
  }

  public findById(artifactId: string): ArtifactRecord | null {
    const row = this.database
      .prepare("SELECT * FROM artifacts WHERE artifact_id = ?")
      .get(artifactId) as unknown as ArtifactRow | undefined;

    return row === undefined ? null : toArtifactRecord(row);
  }

  public findLatestByType(artifactType: string): ArtifactRecord | null {
    const row = this.database
      .prepare("SELECT * FROM artifacts WHERE artifact_type = ? ORDER BY created_at DESC LIMIT 1")
      .get(artifactType) as unknown as ArtifactRow | undefined;

    return row === undefined ? null : toArtifactRecord(row);
  }
}

function toArtifactRecord(row: ArtifactRow): ArtifactRecord {
  return {
    artifactId: row.artifact_id,
    artifactType: row.artifact_type,
    content: parseJsonValue<JsonValue>(row.content_json),
    createdAt: row.created_at,
    taskId: row.task_id,
    toolCallId: row.tool_call_id,
    uri: row.uri
  };
}
