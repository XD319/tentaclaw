import type { AgentDoctorReport } from "../runtime";
import type { TaskRecord, TraceEvent, ToolCallRecord } from "../types";

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

export function formatTask(task: TaskRecord, toolCalls: ToolCallRecord[]): string {
  const header = [
    `Task ID: ${task.taskId}`,
    `Status: ${task.status}`,
    `Input: ${task.input}`,
    `Provider: ${task.providerName}`,
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

  return `${header}\n${toolCallSection}`;
}

export function formatTrace(traceEvents: TraceEvent[]): string {
  if (traceEvents.length === 0) {
    return "No trace events found.";
  }

  return traceEvents.map((event) => formatTraceEvent(event)).join("\n\n");
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
