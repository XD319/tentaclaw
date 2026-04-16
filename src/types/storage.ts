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
