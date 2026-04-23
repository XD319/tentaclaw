import type { GatewaySessionBinding } from "./adapter.js";
import type { GatewaySessionBindingDraft } from "./gateway.js";
import type {
  ThreadDraft,
  ThreadLineageDraft,
  ThreadLineageRecord,
  ThreadRecord,
  ThreadRunDraft,
  ThreadRunRecord,
  ThreadStatus,
  ThreadUpdatePatch
} from "./thread.js";
import type { ThreadSnapshotDraft, ThreadSnapshotRecord } from "./thread-snapshot.js";
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
import type {
  ScheduleDraft,
  ScheduleDueQuery,
  ScheduleListQuery,
  ScheduleRecord,
  ScheduleRunDraft,
  ScheduleRunListQuery,
  ScheduleRunRecord,
  ScheduleRunUpdatePatch,
  ScheduleUpdatePatch
} from "./schedule.js";
import type {
  InboxDedupQuery,
  InboxItem,
  InboxItemDraft,
  InboxItemUpdatePatch,
  InboxListQuery
} from "./inbox.js";

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

export interface ThreadListQuery {
  ownerUserId?: string;
  status?: ThreadStatus;
}

export interface ThreadRepository {
  create(thread: ThreadDraft): ThreadRecord;
  findById(threadId: string): ThreadRecord | null;
  list(query?: ThreadListQuery): ThreadRecord[];
  update(threadId: string, patch: ThreadUpdatePatch): ThreadRecord;
  findLatestByOwner(ownerUserId: string): ThreadRecord | null;
}

export interface ThreadRunRepository {
  create(record: ThreadRunDraft): ThreadRunRecord;
  findByTaskId(taskId: string): ThreadRunRecord | null;
  listByThreadId(threadId: string): ThreadRunRecord[];
  findLatestByThreadId(threadId: string): ThreadRunRecord | null;
}

export interface ThreadLineageRepository {
  append(record: ThreadLineageDraft): ThreadLineageRecord;
  listByThreadId(threadId: string): ThreadLineageRecord[];
}

export interface ThreadSnapshotRepository {
  create(record: ThreadSnapshotDraft): ThreadSnapshotRecord;
  findById(snapshotId: string): ThreadSnapshotRecord | null;
  findLatestByThread(threadId: string): ThreadSnapshotRecord | null;
  listByThread(threadId: string): ThreadSnapshotRecord[];
}

export interface ScheduleRepository {
  create(record: ScheduleDraft): ScheduleRecord;
  findById(scheduleId: string): ScheduleRecord | null;
  list(query?: ScheduleListQuery): ScheduleRecord[];
  update(scheduleId: string, patch: ScheduleUpdatePatch): ScheduleRecord;
  findDue(query: ScheduleDueQuery): ScheduleRecord[];
}

export interface ScheduleRunRepository {
  create(record: ScheduleRunDraft): ScheduleRunRecord;
  findById(runId: string): ScheduleRunRecord | null;
  listByScheduleId(scheduleId: string, query?: ScheduleRunListQuery): ScheduleRunRecord[];
  listByTaskId(taskId: string): ScheduleRunRecord[];
  listByThreadId(threadId: string): ScheduleRunRecord[];
  claimDue(now: string, limit: number): ScheduleRunRecord[];
  update(runId: string, patch: ScheduleRunUpdatePatch): ScheduleRunRecord;
}

export interface InboxRepository {
  create(record: InboxItemDraft): InboxItem;
  findById(inboxId: string): InboxItem | null;
  findByDedup(query: InboxDedupQuery): InboxItem | null;
  list(query?: InboxListQuery): InboxItem[];
  update(inboxId: string, patch: InboxItemUpdatePatch): InboxItem;
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
