import type { SessionCompactInput, SessionCompactTriggerReason } from "../types/index.js";

export interface CompactDecision {
  triggered: boolean;
  reason: SessionCompactTriggerReason | "unsafe_breakpoint" | "cooldown" | null;
}

export function resolveCompactCooldown(input: {
  cooldownIterations: number;
  postCompactTokens: number;
  tokenThreshold: number | null | undefined;
}): number {
  if (input.cooldownIterations <= 0) {
    return 0;
  }
  const threshold = input.tokenThreshold;
  if (threshold === undefined || threshold === null) {
    return 0;
  }
  return input.postCompactTokens >= threshold ? input.cooldownIterations : 0;
}

export class CompactTriggerPolicy {
  public shouldCompact(input: SessionCompactInput): CompactDecision {
    if (!isSafeCompactPoint(input)) {
      return {
        reason: "unsafe_breakpoint",
        triggered: false
      };
    }

    if ((input.compactCooldownRemaining ?? 0) > 0) {
      return {
        reason: "cooldown",
        triggered: false
      };
    }

    if ((input.tokenThreshold ?? Number.POSITIVE_INFINITY) <= (input.tokenEstimate ?? 0)) {
      return {
        reason: "token_budget",
        triggered: true
      };
    }

    const tokenPressureMet = hasTokenPressure(input);

    if (
      tokenPressureMet &&
      (input.toolCallThreshold ?? Number.POSITIVE_INFINITY) <= (input.toolCallCount ?? 0)
    ) {
      return {
        reason: "tool_call_count",
        triggered: true
      };
    }

    if (
      tokenPressureMet &&
      (input.iterationThreshold ?? Number.POSITIVE_INFINITY) <= (input.iteration ?? 0)
    ) {
      return {
        reason: "iteration_count",
        triggered: true
      };
    }

    if (tokenPressureMet && input.messages.length >= input.maxMessagesBeforeCompact) {
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

function hasTokenPressure(input: SessionCompactInput): boolean {
  const ratio = input.minTokenPressureRatio ?? 0.5;
  if (ratio <= 0) {
    return true;
  }
  const threshold = input.tokenThreshold;
  if (threshold === undefined || threshold === null || !Number.isFinite(threshold)) {
    return true;
  }
  return (input.tokenEstimate ?? 0) >= ratio * threshold;
}

function isSafeCompactPoint(input: SessionCompactInput): boolean {
  if ((input.pendingToolCalls?.length ?? 0) > 0) {
    return false;
  }
  const lastMessage = input.messages[input.messages.length - 1];
  if (lastMessage?.role === "tool") {
    return true;
  }
  if (lastMessage?.role === "assistant" && (lastMessage.toolCalls?.length ?? 0) === 0) {
    return true;
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
