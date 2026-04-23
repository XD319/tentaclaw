import type { GatewaySessionBinding } from "./adapter.js";
import type { GatewaySessionBindingDraft } from "./gateway.js";
import type { ApprovalDraft, ApprovalRecord, ApprovalUpdatePatch } from "./approval.js";
import type { AuditLogDraft, AuditLogRecord } from "./audit.js";
import type { ExecutionCheckpointRecord } from "./checkpoint.js";
import type {
  ExperienceDraft,
  ExperienceQuery,
  ExperienceRecord,
  ExperienceUpdatePatch
} from "./experience.js";
import type {
  MemoryDraft,
  MemoryQuery,
  MemoryRecord,
  MemorySnapshotDraft,
  MemorySnapshotRecord,
  MemoryUpdatePatch
} from "./memory.js";
import type { ArtifactDraft, ArtifactRecord, ToolCallRecord } from "./tool.js";
import type { TraceEvent } from "./trace.js";
import type { RunMetadataRecord, TaskDraft, TaskRecord, TaskStatus } from "./task.js";
import type { RuntimeErrorCode } from "./error.js";

export interface TaskUpdatePatch {
  status?: TaskStatus;
  currentIteration?: number;
  startedAt?: string | null;
  finishedAt?: string | null;
  finalOutput?: string | null;
  errorCode?: RuntimeErrorCode | null;
  errorMessage?: string | null;
}

export interface TaskRepository {
  create(task: TaskDraft): TaskRecord;
  findById(taskId: string): TaskRecord | null;
  list(): TaskRecord[];
  update(taskId: string, patch: TaskUpdatePatch): TaskRecord;
}

export interface TraceRepository {
  append(event: Omit<TraceEvent, "sequence">): TraceEvent;
  listByTaskId(taskId: string): TraceEvent[];
}

export interface ToolCallRepository {
  create(record: ToolCallRecord): ToolCallRecord;
  findById(toolCallId: string): ToolCallRecord | null;
  update(toolCallId: string, patch: Partial<ToolCallRecord>): ToolCallRecord;
  listByTaskId(taskId: string): ToolCallRecord[];
}

export interface ArtifactRepository {
  createMany(
    taskId: string,
    toolCallId: string | null,
    artifacts: ArtifactDraft[]
  ): ArtifactRecord[];
  findById(artifactId: string): ArtifactRecord | null;
  findLatestByType(artifactType: string): ArtifactRecord | null;
  listByTaskId(taskId: string): ArtifactRecord[];
}

export interface RunMetadataRepository {
  create(record: RunMetadataRecord): RunMetadataRecord;
  findByTaskId(taskId: string): RunMetadataRecord | null;
}

export interface ApprovalRepository {
  create(record: ApprovalDraft): ApprovalRecord;
  findById(approvalId: string): ApprovalRecord | null;
  findLatestByToolCall(taskId: string, toolCallId: string): ApprovalRecord | null;
  listByTaskId(taskId: string): ApprovalRecord[];
  listPending(): ApprovalRecord[];
  update(approvalId: string, patch: ApprovalUpdatePatch): ApprovalRecord;
}

export interface AuditLogRepository {
  append(record: AuditLogDraft): AuditLogRecord;
  listByTaskId(taskId: string): AuditLogRecord[];
}

export interface ExecutionCheckpointRepository {
  save(record: ExecutionCheckpointRecord): ExecutionCheckpointRecord;
  findByTaskId(taskId: string): ExecutionCheckpointRecord | null;
  delete(taskId: string): void;
}

export interface MemoryRepository {
  create(record: MemoryDraft): MemoryRecord;
  findById(memoryId: string): MemoryRecord | null;
  list(query?: MemoryQuery): MemoryRecord[];
  update(memoryId: string, patch: MemoryUpdatePatch): MemoryRecord;
}

export interface ExperienceRepository {
  create(record: ExperienceDraft): ExperienceRecord;
  findById(experienceId: string): ExperienceRecord | null;
  list(query?: ExperienceQuery): ExperienceRecord[];
  update(experienceId: string, patch: ExperienceUpdatePatch): ExperienceRecord;
}

export interface MemorySnapshotRepository {
  create(record: MemorySnapshotDraft): MemorySnapshotRecord;
  findById(snapshotId: string): MemorySnapshotRecord | null;
  listByScope(scope: MemorySnapshotRecord["scope"], scopeKey: string): MemorySnapshotRecord[];
}

export interface GatewaySessionRepository {
  create(record: GatewaySessionBindingDraft): GatewaySessionBinding;
  findLatestByExternalSession(
    adapterId: string,
    externalSessionId: string
  ): GatewaySessionBinding | null;
  listByExternalSession(adapterId: string, externalSessionId: string): GatewaySessionBinding[];
  findByTaskId(taskId: string): GatewaySessionBinding | null;
}
