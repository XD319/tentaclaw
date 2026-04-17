import type { ApprovalDraft, ApprovalRecord, ApprovalUpdatePatch } from "./approval";
import type { AuditLogDraft, AuditLogRecord } from "./audit";
import type { ExecutionCheckpointRecord } from "./checkpoint";
import type {
  MemoryDraft,
  MemoryQuery,
  MemoryRecord,
  MemorySnapshotDraft,
  MemorySnapshotRecord,
  MemoryUpdatePatch
} from "./memory";
import type { ArtifactDraft, ArtifactRecord, ToolCallRecord } from "./tool";
import type { TraceEvent } from "./trace";
import type { RunMetadataRecord, TaskDraft, TaskRecord, TaskStatus } from "./task";
import type { RuntimeErrorCode } from "./error";

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

export interface MemorySnapshotRepository {
  create(record: MemorySnapshotDraft): MemorySnapshotRecord;
  findById(snapshotId: string): MemorySnapshotRecord | null;
  listByScope(scope: MemorySnapshotRecord["scope"], scopeKey: string): MemorySnapshotRecord[];
}
