import { describe, expect, it } from "vitest";

import { CompactTriggerPolicy } from "../src/memory/compact-policy.js";

describe("CompactTriggerPolicy breakpoints", () => {
  it("does not compact while pending tool calls exist", () => {
    const policy = new CompactTriggerPolicy();
    const decision = policy.shouldCompact({
      maxMessagesBeforeCompact: 2,
      messages: [
        { content: "hi", role: "user" },
        { content: "need tool", role: "assistant" }
      ],
      pendingToolCalls: [{ toolCallId: "tc-1", toolName: "file_read" }],
      sessionScopeKey: "s1",
      taskId: "t1"
    });

    expect(decision.triggered).toBe(false);
    expect(decision.reason).toBe("unsafe_breakpoint");
  });

  it("triggers compaction with token and tool-call thresholds", () => {
    const policy = new CompactTriggerPolicy();
    const tokenDecision = policy.shouldCompact({
      maxMessagesBeforeCompact: 50,
      messages: [{ content: "x", role: "user" }],
      sessionScopeKey: "s1",
      taskId: "t1",
      tokenEstimate: 1000,
      tokenThreshold: 100
    });
    expect(tokenDecision.reason).toBe("token_budget");

    const toolDecision = policy.shouldCompact({
      maxMessagesBeforeCompact: 50,
      messages: [{ content: "x", role: "user" }],
      sessionScopeKey: "s1",
      taskId: "t1",
      toolCallCount: 30,
      toolCallThreshold: 20
    });
    expect(toolDecision.reason).toBe("tool_call_count");
  });
});
