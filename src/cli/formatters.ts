import type { AgentDoctorReport } from "../runtime";
import type {
  ApprovalRecord,
  AuditLogRecord,
  MemoryRecord,
  MemorySnapshotRecord,
  TaskRecord,
  TraceEvent,
  ToolCallRecord
} from "../types";

import { formatTraceEvent } from "../tracing/trace-formatter";

export function formatTaskList(tasks: TaskRecord[]): string {
  if (tasks.length === 0) {
    return "No tasks found.";
  }

  return tasks
    .map(
      (task) =>
        `${task.taskId} | ${task.status} | iter=${task.currentIteration}/${task.maxIterations} | ${task.input}`
    )
    .join("\n");
}

export function formatTask(
  task: TaskRecord,
  toolCalls: ToolCallRecord[],
  approvals: ApprovalRecord[] = []
): string {
  const header = [
    `Task ID: ${task.taskId}`,
    `Status: ${task.status}`,
    `Input: ${task.input}`,
    `Provider: ${task.providerName}`,
    `Profile: ${task.agentProfileId}`,
    `Requester: ${task.requesterUserId}`,
    `CWD: ${task.cwd}`,
    `Iterations: ${task.currentIteration}/${task.maxIterations}`,
    `Created: ${task.createdAt}`,
    `Started: ${task.startedAt ?? "-"}`,
    `Finished: ${task.finishedAt ?? "-"}`,
    `Output: ${task.finalOutput ?? "-"}`,
    `Error: ${task.errorCode ?? "-"} ${task.errorMessage ?? ""}`.trim()
  ].join("\n");

  const toolCallSection =
    toolCalls.length === 0
      ? "Tool Calls: none"
      : [
          "Tool Calls:",
          ...toolCalls.map(
            (toolCall) =>
              `- ${toolCall.toolCallId} ${toolCall.toolName} ${toolCall.status} ${toolCall.summary ?? ""}`.trim()
          )
        ].join("\n");

  const approvalSection =
    approvals.length === 0
      ? "Approvals: none"
      : [
          "Approvals:",
          ...approvals.map(
            (approval) =>
              `- ${approval.approvalId} ${approval.toolName} ${approval.status} reviewer=${approval.reviewerId ?? "-"} expires=${approval.expiresAt}`
          )
        ].join("\n");

  return `${header}\n${toolCallSection}\n${approvalSection}`;
}

export function formatTrace(traceEvents: TraceEvent[]): string {
  if (traceEvents.length === 0) {
    return "No trace events found.";
  }

  return traceEvents.map((event) => formatTraceEvent(event)).join("\n\n");
}

export function formatApprovalList(approvals: ApprovalRecord[]): string {
  if (approvals.length === 0) {
    return "No pending approvals.";
  }

  return approvals
    .map(
      (approval) =>
        `${approval.approvalId} | ${approval.taskId} | ${approval.toolName} | ${approval.status} | expires=${approval.expiresAt}`
    )
    .join("\n");
}

export function formatAuditLog(entries: AuditLogRecord[]): string {
  if (entries.length === 0) {
    return "No audit log entries found.";
  }

  return entries
    .map(
      (entry) =>
        `${entry.createdAt} | ${entry.action} | ${entry.outcome} | ${entry.actor} | ${entry.summary}`
    )
    .join("\n");
}

export function formatDoctorReport(report: AgentDoctorReport): string {
  return [
    `Runtime Version: ${report.runtimeVersion}`,
    `Provider: ${report.providerName}`,
    `Node: ${report.nodeVersion}`,
    `Workspace Root: ${report.workspaceRoot}`,
    `Database Path: ${report.databasePath}`,
    `Shell: ${report.shell ?? "-"}`
  ].join("\n");
}

export function formatMemoryList(memories: MemoryRecord[]): string {
  if (memories.length === 0) {
    return "No memories found.";
  }

  return memories
    .map(
      (memory) =>
        `${memory.memoryId} | ${memory.scope}:${memory.scopeKey} | ${memory.status} | confidence=${memory.confidence.toFixed(2)} | privacy=${memory.privacyLevel} | ${memory.title}`
    )
    .join("\n");
}

export function formatMemoryScope(
  scope: string,
  scopeKey: string,
  memories: MemoryRecord[],
  snapshots: MemorySnapshotRecord[]
): string {
  const memorySection =
    memories.length === 0
      ? "Memories: none"
      : ["Memories:", ...memories.map((memory) => formatMemoryDetail(memory))].join("\n");
  const snapshotSection =
    snapshots.length === 0
      ? "Snapshots: none"
      : [
          "Snapshots:",
          ...snapshots.map(
            (snapshot) =>
              `- ${snapshot.snapshotId} ${snapshot.label} created=${snapshot.createdAt} count=${snapshot.memoryIds.length}`
          )
        ].join("\n");

  return [`Scope: ${scope}`, `Scope Key: ${scopeKey}`, memorySection, snapshotSection].join("\n");
}

export function formatSnapshot(snapshot: MemorySnapshotRecord): string {
  return [
    `Snapshot ID: ${snapshot.snapshotId}`,
    `Scope: ${snapshot.scope}`,
    `Scope Key: ${snapshot.scopeKey}`,
    `Label: ${snapshot.label}`,
    `Created By: ${snapshot.createdBy}`,
    `Created At: ${snapshot.createdAt}`,
    `Memory Count: ${snapshot.memoryIds.length}`,
    `Summary: ${snapshot.summary}`
  ].join("\n");
}

function formatMemoryDetail(memory: MemoryRecord): string {
  const conflicts =
    memory.conflictsWith.length === 0 ? "-" : memory.conflictsWith.join(",");

  return [
    `- ${memory.memoryId} ${memory.title}`,
    `  status=${memory.status} confidence=${memory.confidence.toFixed(2)} privacy=${memory.privacyLevel} source=${memory.sourceType}`,
    `  created=${memory.createdAt} updated=${memory.updatedAt} verified=${memory.lastVerifiedAt ?? "-"} expires=${memory.expiresAt ?? "-"}`,
    `  conflicts=${conflicts} supersedes=${memory.supersedes ?? "-"}`,
    `  summary=${memory.summary}`
  ].join("\n");
}
