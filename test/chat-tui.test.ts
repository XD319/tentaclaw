import { describe, expect, it } from "vitest";

import { mergeTraceMessages } from "../src/tui/hooks/use-chat-controller";
import {
  deletePreviousWord,
  moveCursorVertical
} from "../src/tui/hooks/use-text-input";
import {
  resolveApprovalMessage,
  toApprovalMessage,
  toTraceActivityMessage
} from "../src/tui/view-models/chat-messages";
import type { ApprovalRecord, ToolCallRecord, TraceEvent } from "../src/types";

describe("chat tui view-models", () => {
  it("formats trace events into activity messages", () => {
    const event = createTraceEvent("tool_call_started", {
      iteration: 1,
      toolCallId: "call-00112233",
      toolName: "file_write"
    });

    const message = toTraceActivityMessage(event);
    expect(message.kind).toBe("activity");
    expect(message.text).toContain("tool_call_started file_write");
  });

  it("marks approval message as resolved", () => {
    const approval = createApprovalRecord();
    const toolCall = createToolCallRecord();
    const message = toApprovalMessage(approval, toolCall);
    const resolved = resolveApprovalMessage(message, "allow");

    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution).toBe("allow");
  });
});

describe("use-chat-controller helpers", () => {
  it("merges only unseen trace activity messages", () => {
    const first = createTraceEvent("tool_call_started", {
      iteration: 1,
      toolCallId: "call-1",
      toolName: "shell_exec"
    });
    const second = createTraceEvent("tool_call_finished", {
      iteration: 1,
      outputPreview: "ok",
      summary: "done",
      toolCallId: "call-1",
      toolName: "shell_exec"
    });

    const mergedOnce = mergeTraceMessages([], [first, second]);
    const mergedTwice = mergeTraceMessages(mergedOnce, [first, second]);

    expect(mergedOnce.length).toBe(2);
    expect(mergedTwice.length).toBe(2);
  });
});

describe("use-text-input helpers", () => {
  it("moves cursor up preserving preferred column", () => {
    const value = "abcd\na\nabcdef";
    const startIndex = value.length;

    const firstUp = moveCursorVertical(value, startIndex, -1, null);
    const secondUp = moveCursorVertical(value, firstUp.index, -1, firstUp.preferredColumn);

    expect(firstUp.index).toBe("abcd\na".length);
    expect(secondUp.index).toBe("abcd".length);
  });

  it("moves cursor down and clamps to shorter lines", () => {
    const value = "abcdef\nab\nabcdef";
    const start = "abc".length;
    const down = moveCursorVertical(value, start, 1, null);
    const downAgain = moveCursorVertical(value, down.index, 1, down.preferredColumn);

    expect(down.index).toBe("abcdef\nab".length);
    expect(downAgain.index).toBe("abcdef\nab\nabc".length);
  });

  it("deletes previous word with ctrl+w behavior", () => {
    const result = deletePreviousWord("hello brave world", "hello brave world".length);
    expect(result.value).toBe("hello brave ");
    expect(result.cursorIndex).toBe("hello brave ".length);
  });

  it("deletes trailing whitespace and previous word", () => {
    const result = deletePreviousWord("hello brave   ", "hello brave   ".length);
    expect(result.value).toBe("hello ");
    expect(result.cursorIndex).toBe("hello ".length);
  });
});

function createTraceEvent(
  eventType: TraceEvent["eventType"],
  payload: Record<string, unknown>
): TraceEvent {
  return {
    actor: "agent.runtime",
    eventId: `${eventType}-id`,
    eventType,
    payload,
    sequence: 1,
    stage: "tooling",
    summary: "summary",
    taskId: "task-001",
    timestamp: "2026-01-01T00:00:00.000Z"
  } as TraceEvent;
}

function createApprovalRecord(): ApprovalRecord {
  return {
    approvalId: "approval-1",
    decidedAt: null,
    errorCode: null,
    expiresAt: "2026-01-01T01:00:00.000Z",
    policyDecisionId: "policy-1",
    reason: "Need to write files",
    requestedAt: "2026-01-01T00:00:00.000Z",
    requesterUserId: "user-1",
    reviewerId: null,
    reviewerNotes: null,
    status: "pending",
    taskId: "task-001",
    toolCallId: "call-001",
    toolName: "file_write"
  };
}

function createToolCallRecord(): ToolCallRecord {
  return {
    errorCode: null,
    errorMessage: null,
    finishedAt: null,
    input: {},
    iteration: 1,
    output: null,
    requestedAt: "2026-01-01T00:00:00.000Z",
    riskLevel: "medium",
    startedAt: null,
    status: "awaiting_approval",
    summary: null,
    taskId: "task-001",
    toolCallId: "call-001",
    toolName: "file_write"
  };
}
