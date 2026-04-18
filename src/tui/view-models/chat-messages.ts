import type { ApprovalRecord, ToolCallRecord, TraceEvent } from "../../types";

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

function formatTraceEvent(event: TraceEvent): string {
  switch (event.eventType) {
    case "tool_call_requested":
    case "tool_call_started":
    case "tool_call_finished":
    case "tool_call_failed":
      return `${event.eventType} ${event.payload.toolName} (${event.payload.toolCallId.slice(0, 8)})`;
    case "approval_requested":
      return `${event.eventType} ${event.payload.toolName} (pending)`;
    case "approval_resolved":
      return `${event.eventType} ${event.payload.toolName} (${event.payload.status})`;
    case "final_outcome":
      return `final_outcome ${event.payload.status}`;
    case "provider_request_failed":
      return `${event.eventType} ${event.payload.errorCategory}`;
    default:
      return `${event.eventType} ${event.summary}`;
  }
}
