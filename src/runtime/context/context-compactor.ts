import { randomUUID } from "node:crypto";

import type {
  ContextFragment,
  ProviderToolDescriptor,
  SessionCompactInput,
  TaskRecord,
  ThreadSnapshotDraft
} from "../../types/index.js";
import { serializeFocusState, type FocusState } from "../focus-state.js";

export interface BuildSnapshotInput {
  task: TaskRecord;
  compact: SessionCompactInput & { reason: "message_count" | "context_budget" | "token_budget" | "tool_call_count" };
  focusState?: FocusState;
  memoryContext: ContextFragment[];
  availableTools: ProviderToolDescriptor[];
  trigger?: ThreadSnapshotDraft["trigger"];
}

export class ContextCompactor {
  public buildSnapshot(input: BuildSnapshotInput): ThreadSnapshotDraft {
    const goal = summarize(
      input.compact.messages.find((message) => message.role === "user")?.content ?? input.task.input,
      500
    );
    const unresolvedToolCalls = new Map<string, string>();
    const resolvedToolCalls = new Set<string>();
    for (const message of input.compact.messages) {
      if (message.role === "assistant" && Array.isArray(message.toolCalls)) {
        for (const call of message.toolCalls) {
          unresolvedToolCalls.set(call.toolCallId, call.toolName);
        }
      }
      if (message.role === "tool" && typeof message.toolCallId === "string") {
        resolvedToolCalls.add(message.toolCallId);
      }
    }
    const openLoops = [...unresolvedToolCalls.entries()]
      .filter(([toolCallId]) => !resolvedToolCalls.has(toolCallId))
      .map(([toolCallId, toolName]) => `pending ${toolName} (${toolCallId})`);
    const blockedReason = findBlockedReason(input.compact.messages);
    const nextActions = collectNextActions(input.compact.messages);
    const activeMemoryIds = uniqueList(input.memoryContext.map((fragment) => fragment.memoryId));
    const toolCapabilitySummary = uniqueList([
      ...collectUsedTools(input.compact.messages),
      ...input.availableTools.map((tool) => tool.name)
    ]);
    const summary = [
      `goal=${goal || "[n/a]"}`,
      `open_loops=${openLoops.join("; ") || "[none]"}`,
      `blocked=${blockedReason ?? "[none]"}`,
      `next_actions=${nextActions.join("; ") || "[none]"}`,
      `active_memories=${activeMemoryIds.length}`,
      `capabilities=${toolCapabilitySummary.join(", ") || "[none]"}`
    ].join("\n");

    return {
      snapshotId: randomUUID(),
      threadId: input.task.threadId ?? "",
      runId: null,
      taskId: input.task.taskId,
      trigger: input.trigger ?? "compact",
      goal,
      openLoops,
      blockedReason,
      nextActions,
      activeMemoryIds,
      toolCapabilitySummary,
      summary,
      metadata: {
        compactReason: input.compact.reason,
        compactTaskId: input.compact.taskId,
        ...(input.focusState !== undefined ? { focusState: serializeFocusState(input.focusState) } : {})
      }
    };
  }
}

function collectUsedTools(messages: SessionCompactInput["messages"]): string[] {
  const names: string[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls) {
        names.push(call.toolName);
      }
    }
    if (message.role === "tool" && typeof message.toolName === "string") {
      names.push(message.toolName);
    }
  }
  return uniqueList(names);
}

function collectNextActions(messages: SessionCompactInput["messages"]): string[] {
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (lastAssistant === undefined) {
    return [];
  }
  const actions: string[] = [];
  if (Array.isArray(lastAssistant.toolCalls) && lastAssistant.toolCalls.length > 0) {
    actions.push(
      ...lastAssistant.toolCalls.map((call) => `run ${call.toolName} (${call.toolCallId})`)
    );
  }
  const compact = summarize(lastAssistant.content, 240);
  if (compact.length > 0) {
    actions.push(compact);
  }
  return uniqueList(actions);
}

function findBlockedReason(messages: SessionCompactInput["messages"]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) {
      continue;
    }
    if (message.role !== "tool") {
      continue;
    }
    const lowered = message.content.toLowerCase();
    if (
      lowered.includes("approval_denied") ||
      lowered.includes("approval denied") ||
      lowered.includes("permission denied") ||
      lowered.includes("error") ||
      lowered.includes("failed")
    ) {
      return summarize(message.content, 240);
    }
  }
  return null;
}

function uniqueList(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function summarize(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength)}...`;
}
