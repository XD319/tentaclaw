import type {
  ProviderToolDescriptor,
  SessionCompactInput,
  TaskRecord,
  ThreadSessionMemoryDraft
} from "../../types/index.js";
import {
  collectStructuredSummaryFields,
  formatStructuredSummary,
  redactSensitiveSummary
} from "../../memory/compact-summarizer.js";

export interface BuildSessionMemoryInput {
  task: TaskRecord;
  compact: SessionCompactInput & { reason: "message_count" | "context_budget" | "token_budget" | "tool_call_count" };
  availableTools: ProviderToolDescriptor[];
  trigger?: ThreadSessionMemoryDraft["trigger"];
}

export class ContextCompactor {
  public buildSessionMemory(input: BuildSessionMemoryInput): ThreadSessionMemoryDraft {
    const goal = redactSensitiveSummary(
      summarize(
      input.compact.messages.find((message) => message.role === "user")?.content ?? input.task.input,
      500
      )
    );
    const decisions = collectDecisions(input.compact.messages).map((item) => redactSensitiveSummary(item));
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
      .map(([toolCallId, toolName]) => redactSensitiveSummary(`pending ${toolName} (${toolCallId})`));
    const nextActions = collectNextActions(input.compact.messages).map((item) => redactSensitiveSummary(item));
    const structured = collectStructuredSummaryFields(input.compact);
    const summary = redactSensitiveSummary(
      [
        formatStructuredSummary(structured),
        `decisions=${decisions.join("; ") || "[none]"}`,
        `open_loops=${openLoops.join("; ") || "[none]"}`,
        `next_actions=${nextActions.join("; ") || "[none]"}`
      ].join("\n")
    );

    return {
      decisions,
      goal,
      metadata: {
        compactReason: input.compact.reason,
        compactTaskId: input.compact.taskId,
        toolCapabilitySummary: uniqueList([
          ...collectUsedTools(input.compact.messages),
          ...input.availableTools.map((tool) => tool.name)
        ])
      },
      nextActions,
      openLoops,
      runId: null,
      summary,
      taskId: input.task.taskId,
      threadId: input.task.threadId ?? "",
      trigger: input.trigger ?? "compact"
    };
  }

  public buildSnapshot(input: BuildSessionMemoryInput): {
    activeMemoryIds: string[];
    blockedReason: string | null;
    goal: string;
    metadata: ThreadSessionMemoryDraft["metadata"];
    nextActions: string[];
    openLoops: string[];
    runId: string | null;
    snapshotId: string;
    summary: string;
    taskId: string | null;
    threadId: string;
    toolCapabilitySummary: string[];
    trigger: ThreadSessionMemoryDraft["trigger"];
  } {
    const sessionMemory = this.buildSessionMemory(input);
    const toolCapabilitySummary = Array.isArray(sessionMemory.metadata?.toolCapabilitySummary)
      ? sessionMemory.metadata.toolCapabilitySummary.filter((item): item is string => typeof item === "string")
      : [];
    return {
      activeMemoryIds: [],
      blockedReason: sessionMemory.openLoops[0] ?? null,
      goal: sessionMemory.goal,
      metadata: sessionMemory.metadata,
      nextActions: sessionMemory.nextActions,
      openLoops: sessionMemory.openLoops,
      runId: sessionMemory.runId ?? null,
      snapshotId: sessionMemory.sessionMemoryId ?? "session-memory-compat",
      summary: sessionMemory.summary,
      taskId: sessionMemory.taskId ?? null,
      threadId: sessionMemory.threadId,
      toolCapabilitySummary,
      trigger: sessionMemory.trigger
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
    actions.push(...lastAssistant.toolCalls.map((call) => `run ${call.toolName} (${call.toolCallId})`));
  }
  const compact = normalizeMemoryLine(lastAssistant.content, 120);
  if (compact.length > 0 && looksActionable(compact)) {
    actions.push(compact);
  }
  return uniqueList(actions).slice(0, 3);
}

function collectDecisions(messages: SessionCompactInput["messages"]): string[] {
  const candidates = messages
    .filter((message) => message.role === "assistant" || message.role === "user")
    .slice(-6)
    .map((message) => normalizeMemoryLine(message.content, 120))
    .filter((message) => message.length > 0);
  return uniqueList(candidates).slice(-3);
}

function uniqueList(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function summarize(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength)}...`;
}

function normalizeMemoryLine(value: string, maxLength: number): string {
  const compact = value
    .replace(/[`#>*_|~]/gu, " ")
    .replace(/\[(.*?)\]\((.*?)\)/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
  if (compact.length === 0) {
    return "";
  }
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength)}...`;
}

function looksActionable(value: string): boolean {
  return (
    /\b(run|write|update|fix|create|check|verify|read|search|continue|summarize|execute)\b/iu.test(
      value
    ) ||
    /执行|写入|更新|修复|创建|检查|验证|读取|搜索|继续|总结/u.test(value)
  );
}
