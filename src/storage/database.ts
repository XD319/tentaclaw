import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { runMigrations } from "./migrations.js";
import { SqliteApprovalRepository } from "./repositories/approval-repository.js";
import { SqliteArtifactRepository } from "./repositories/artifact-repository.js";
import { SqliteAuditLogRepository } from "./repositories/audit-log-repository.js";
import { SqliteExecutionCheckpointRepository } from "./repositories/execution-checkpoint-repository.js";
import { SqliteExperienceRepository } from "./repositories/experience-repository.js";
import { SqliteGatewaySessionRepository } from "./repositories/gateway-session-repository.js";
import { SqliteMemoryRepository } from "./repositories/memory-repository.js";
import { SqliteMemorySnapshotRepository } from "./repositories/memory-snapshot-repository.js";
import { SqliteRunMetadataRepository } from "./repositories/run-metadata-repository.js";
import { SqliteScheduleRepository } from "./repositories/schedules/schedule-repository.js";
import { SqliteScheduleRunRepository } from "./repositories/schedules/schedule-run-repository.js";
import { SqliteTaskRepository } from "./repositories/task-repository.js";
import { SqliteThreadLineageRepository } from "./repositories/thread-lineage-repository.js";
import { SqliteThreadRepository } from "./repositories/thread-repository.js";
import { SqliteThreadRunRepository } from "./repositories/thread-run-repository.js";
import { SqliteThreadSnapshotRepository } from "./repositories/thread-snapshot-repository.js";
import { SqliteToolCallRepository } from "./repositories/tool-call-repository.js";
import { SqliteTraceRepository } from "./repositories/trace-repository.js";

export interface StorageConfig {
  databasePath: string;
}

export class StorageManager {
  public readonly database: DatabaseSync;
  public readonly tasks: SqliteTaskRepository;
  public readonly threads: SqliteThreadRepository;
  public readonly threadRuns: SqliteThreadRunRepository;
  public readonly threadLineage: SqliteThreadLineageRepository;
  public readonly threadSnapshots: SqliteThreadSnapshotRepository;
  public readonly schedules: SqliteScheduleRepository;
  public readonly scheduleRuns: SqliteScheduleRunRepository;
  public readonly traces: SqliteTraceRepository;
  public readonly toolCalls: SqliteToolCallRepository;
  public readonly artifacts: SqliteArtifactRepository;
  public readonly runMetadata: SqliteRunMetadataRepository;
  public readonly approvals: SqliteApprovalRepository;
  public readonly auditLogs: SqliteAuditLogRepository;
  public readonly checkpoints: SqliteExecutionCheckpointRepository;
  public readonly experiences: SqliteExperienceRepository;
  public readonly memories: SqliteMemoryRepository;
  public readonly memorySnapshots: SqliteMemorySnapshotRepository;
  public readonly gatewaySessions: SqliteGatewaySessionRepository;

  public constructor(config: StorageConfig) {
    if (config.databasePath !== ":memory:") {
      mkdirSync(dirname(config.databasePath), { recursive: true });
    }

    this.database = new DatabaseSync(config.databasePath);
    runMigrations(this.database);

    this.tasks = new SqliteTaskRepository(this.database);
    this.threads = new SqliteThreadRepository(this.database);
    this.threadRuns = new SqliteThreadRunRepository(this.database);
    this.threadLineage = new SqliteThreadLineageRepository(this.database);
    this.threadSnapshots = new SqliteThreadSnapshotRepository(this.database);
    this.schedules = new SqliteScheduleRepository(this.database);
    this.scheduleRuns = new SqliteScheduleRunRepository(this.database);
    this.traces = new SqliteTraceRepository(this.database);
    this.toolCalls = new SqliteToolCallRepository(this.database);
    this.artifacts = new SqliteArtifactRepository(this.database);
    this.runMetadata = new SqliteRunMetadataRepository(this.database);
    this.approvals = new SqliteApprovalRepository(this.database);
    this.auditLogs = new SqliteAuditLogRepository(this.database);
    this.checkpoints = new SqliteExecutionCheckpointRepository(this.database);
    this.experiences = new SqliteExperienceRepository(this.database);
    this.memories = new SqliteMemoryRepository(this.database);
    this.memorySnapshots = new SqliteMemorySnapshotRepository(this.database);
    this.gatewaySessions = new SqliteGatewaySessionRepository(this.database);
  }

  public close(): void {
    this.database.close();
  }
}
