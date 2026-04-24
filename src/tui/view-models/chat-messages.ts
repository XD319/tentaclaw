import type { ApprovalRecord, ToolCallRecord, TraceEvent } from "../../types/index.js";

export type ChatMessage =
  | {
      kind: "user";
      id: string;
      text: string;
      timestamp: string;
    }
  | {
      kind: "agent";
      id: string;
      streaming?: boolean;
      text: string;
      timestamp: string;
    }
  | {
      kind: "activity";
      id: string;
      event: TraceEvent;
      text: string;
      timestamp: string;
    }
  | {
      kind: "approval";
      id: string;
      approval: ApprovalRecord;
      toolCall: ToolCallRecord | null;
      status: "pending" | "resolved";
      resolution?: "allow" | "deny";
      timestamp: string;
    }
  | {
      kind: "approval_result";
      id: string;
      action: "allow" | "deny";
      approvalId: string;
      taskId: string;
      text: string;
      timestamp: string;
      toolName: string;
    }
  | {
      kind: "error";
      id: string;
      code: string;
      message: string;
      source: string;
      timestamp: string;
    }
  | {
      kind: "system";
      id: string;
      text: string;
      timestamp: string;
    };

export function toTraceActivityMessage(event: TraceEvent): ChatMessage {
  return {
    id: `activity:${event.eventId}`,
    kind: "activity",
    event,
    text: formatTraceEvent(event),
    timestamp: event.timestamp
  };
}

export function toApprovalMessage(
  approval: ApprovalRecord,
  toolCall: ToolCallRecord | null
): ChatMessage {
  return {
    approval,
    id: `approval:${approval.approvalId}`,
    kind: "approval",
    status: "pending",
    timestamp: approval.requestedAt,
    toolCall
  };
}

export function resolveApprovalMessage(
  message: Extract<ChatMessage, { kind: "approval" }>,
  resolution: "allow" | "deny"
): Extract<ChatMessage, { kind: "approval" }> {
  return {
    ...message,
    resolution,
    status: "resolved",
    timestamp: new Date().toISOString()
  };
}

export function toApprovalResultMessage(
  approval: ApprovalRecord,
  action: "allow" | "deny"
): ChatMessage {
  const label = action === "allow" ? "Approved" : "Denied";
  return {
    action,
    approvalId: approval.approvalId,
    id: `approval-result:${approval.approvalId}:${action}`,
    kind: "approval_result",
    taskId: approval.taskId,
    text: `${label} ${approval.toolName} for task ${approval.taskId.slice(0, 8)}.`,
    timestamp: new Date().toISOString(),
    toolName: approval.toolName
  };
}

export function displayChatMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => message.kind !== "activity" || isHighValueActivity(message.event));
}

function formatTraceEvent(event: TraceEvent): string {
  switch (event.eventType) {
    case "tool_call_requested": {
      const target = summarizeToolTarget(event.payload.input);
      return target === null
        ? `Queued ${event.payload.toolName} (${event.payload.toolCallId.slice(0, 8)})`
        : `Queued ${event.payload.toolName} ${target}`;
    }
    case "tool_call_started":
      return `Running ${event.payload.toolName} (${event.payload.toolCallId.slice(0, 8)})`;
    case "tool_call_finished":
      return formatFinishedToolCall(event);
    case "tool_call_failed":
      return `Failed ${event.payload.toolName}: ${event.payload.errorMessage}`;
    case "approval_requested":
      return `Approval requested for ${event.payload.toolName}`;
    case "approval_resolved":
      return `Approval ${event.payload.status} for ${event.payload.toolName}`;
    case "final_outcome":
      return `final_outcome ${event.payload.status}`;
    case "provider_request_failed":
      return `Provider request failed: ${event.payload.errorCategory}`;
    default:
      return `${event.eventType}: ${event.summary}`;
  }
}

function formatFinishedToolCall(event: Extract<TraceEvent, { eventType: "tool_call_finished" }>): string {
  const { summary, toolCallId, toolName, outputPreview } = event.payload;
  if (toolName === "web_fetch") {
    const urlTarget = extractUrlTarget(`${summary} ${outputPreview}`);
    return urlTarget === null ? "Fetched webpage" : `Fetched ${urlTarget}`;
  }
  const target = extractPathLikeValue(summary) ?? extractPathLikeValue(outputPreview);
  const diff = extractDiffSummary(`${summary} ${outputPreview}`);
  if (toolName.includes("write")) {
    if (target !== null && diff !== null) {
      return `Write ${target} (${diff})`;
    }
    if (target !== null) {
      return `Write ${target}`;
    }
  }
  const compact = collapseWhitespace(summary).slice(0, 120);
  return compact.length > 0 ? `${toolName} done: ${compact}` : `${toolName} done (${toolCallId.slice(0, 8)})`;
}

function summarizeToolTarget(input: Record<string, unknown>): string | null {
  const candidates = [input["path"], input["url"], input["command"], input["query"], input["keyword"]];
  const value = candidates.find((item): item is string => typeof item === "string" && item.length > 0);
  if (value === undefined) {
    return null;
  }
  return value.length > 72 ? `${value.slice(0, 69)}...` : value;
}

function extractPathLikeValue(value: string): string | null {
  const pathMatch = /(path|file)\s*[=:]\s*([^\s,;]+)/iu.exec(value);
  if (pathMatch?.[2] !== undefined) {
    return pathMatch[2];
  }
  const quoted = /["']([^"']+\.[a-z0-9]{1,8})["']/iu.exec(value);
  if (quoted?.[1] !== undefined) {
    return quoted[1];
  }
  return null;
}

function extractDiffSummary(value: string): string | null {
  const plus = /\+(\d{1,5})/u.exec(value);
  const minus = /-(\d{1,5})/u.exec(value);
  if (plus === null && minus === null) {
    return null;
  }
  return `+${plus?.[1] ?? "0"} -${minus?.[1] ?? "0"}`;
}

function extractUrlTarget(value: string): string | null {
  const urlMatch = /(https?:\/\/[^\s'")\]]+)/iu.exec(value);
  if (urlMatch?.[1] === undefined) {
    return null;
  }
  try {
    const url = new URL(urlMatch[1]);
    const trimmedPath = url.pathname === "/" ? "" : url.pathname;
    const compact = `${url.hostname}${trimmedPath}`;
    return compact.length <= 52 ? compact : `${compact.slice(0, 49)}...`;
  } catch {
    const raw = urlMatch[1];
    return raw.length <= 52 ? raw : `${raw.slice(0, 49)}...`;
  }
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function isHighValueActivity(event: TraceEvent): boolean {
  return (
    event.eventType === "approval_requested" ||
    event.eventType === "approval_resolved" ||
    event.eventType === "interrupt" ||
    event.eventType === "provider_request_failed" ||
    event.eventType === "retry" ||
    event.eventType === "tool_call_failed" ||
    event.eventType === "tool_call_finished"
  );
}
