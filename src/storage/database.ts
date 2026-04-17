import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { runMigrations } from "./migrations";
import { SqliteApprovalRepository } from "./repositories/approval-repository";
import { SqliteArtifactRepository } from "./repositories/artifact-repository";
import { SqliteAuditLogRepository } from "./repositories/audit-log-repository";
import { SqliteExecutionCheckpointRepository } from "./repositories/execution-checkpoint-repository";
import { SqliteMemoryRepository } from "./repositories/memory-repository";
import { SqliteMemorySnapshotRepository } from "./repositories/memory-snapshot-repository";
import { SqliteRunMetadataRepository } from "./repositories/run-metadata-repository";
import { SqliteTaskRepository } from "./repositories/task-repository";
import { SqliteToolCallRepository } from "./repositories/tool-call-repository";
import { SqliteTraceRepository } from "./repositories/trace-repository";

export interface StorageConfig {
  databasePath: string;
}

export class StorageManager {
  public readonly database: DatabaseSync;
  public readonly tasks: SqliteTaskRepository;
  public readonly traces: SqliteTraceRepository;
  public readonly toolCalls: SqliteToolCallRepository;
  public readonly artifacts: SqliteArtifactRepository;
  public readonly runMetadata: SqliteRunMetadataRepository;
  public readonly approvals: SqliteApprovalRepository;
  public readonly auditLogs: SqliteAuditLogRepository;
  public readonly checkpoints: SqliteExecutionCheckpointRepository;
  public readonly memories: SqliteMemoryRepository;
  public readonly memorySnapshots: SqliteMemorySnapshotRepository;

  public constructor(config: StorageConfig) {
    if (config.databasePath !== ":memory:") {
      mkdirSync(dirname(config.databasePath), { recursive: true });
    }

    this.database = new DatabaseSync(config.databasePath);
    runMigrations(this.database);

    this.tasks = new SqliteTaskRepository(this.database);
    this.traces = new SqliteTraceRepository(this.database);
    this.toolCalls = new SqliteToolCallRepository(this.database);
    this.artifacts = new SqliteArtifactRepository(this.database);
    this.runMetadata = new SqliteRunMetadataRepository(this.database);
    this.approvals = new SqliteApprovalRepository(this.database);
    this.auditLogs = new SqliteAuditLogRepository(this.database);
    this.checkpoints = new SqliteExecutionCheckpointRepository(this.database);
    this.memories = new SqliteMemoryRepository(this.database);
    this.memorySnapshots = new SqliteMemorySnapshotRepository(this.database);
  }

  public close(): void {
    this.database.close();
  }
}
