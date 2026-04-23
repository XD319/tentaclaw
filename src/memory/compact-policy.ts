import type { SessionCompactInput, SessionCompactTriggerReason } from "../types/index.js";

export interface CompactDecision {
  triggered: boolean;
  reason: SessionCompactTriggerReason | "unsafe_breakpoint" | null;
}

export class CompactTriggerPolicy {
  public shouldCompact(input: SessionCompactInput): CompactDecision {
    if (!isSafeCompactPoint(input)) {
      return {
        reason: "unsafe_breakpoint",
        triggered: false
      };
    }

    if ((input.toolCallThreshold ?? Number.POSITIVE_INFINITY) <= (input.toolCallCount ?? 0)) {
      return {
        reason: "tool_call_count",
        triggered: true
      };
    }

    if ((input.tokenThreshold ?? Number.POSITIVE_INFINITY) <= (input.tokenEstimate ?? 0)) {
      return {
        reason: "token_budget",
        triggered: true
      };
    }

    if (input.messages.length >= input.maxMessagesBeforeCompact) {
      return {
        reason: "message_count",
        triggered: true
      };
    }

    return {
      reason: null,
      triggered: false
    };
  }
}

function isSafeCompactPoint(input: SessionCompactInput): boolean {
  if ((input.pendingToolCalls?.length ?? 0) > 0) {
    return false;
  }
  const lastAssistantWithCalls = [...input.messages]
    .reverse()
    .find((message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0);
  if (lastAssistantWithCalls === undefined || lastAssistantWithCalls.toolCalls === undefined) {
    return true;
  }

  const fulfilledCalls = new Set(
    input.messages.filter((message) => message.role === "tool").map((message) => message.toolCallId)
  );
  return lastAssistantWithCalls.toolCalls.every((call) => fulfilledCalls.has(call.toolCallId));
}
