import { describe, expect, it } from "vitest";

import { CompactTriggerPolicy, resolveCompactCooldown } from "../src/memory/compact-policy.js";

describe("CompactTriggerPolicy breakpoints", () => {
  it("does not compact while pending tool calls exist", () => {
    const policy = new CompactTriggerPolicy();
    const decision = policy.shouldCompact({
      maxMessagesBeforeCompact: 2,
      messages: [
        { content: "hi", role: "user" },
        { content: "need tool", role: "assistant" }
      ],
      pendingToolCalls: [{ toolCallId: "tc-1", toolName: "read_file" }],
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

    const iterationDecision = policy.shouldCompact({
      iteration: 8,
      iterationThreshold: 8,
      maxMessagesBeforeCompact: 50,
      messages: [{ content: "x", role: "user" }],
      sessionScopeKey: "s1",
      taskId: "t1"
    });
    expect(iterationDecision.reason).toBe("iteration_count");
  });

  it("blocks count triggers when token pressure is below minTokenPressureRatio", () => {
    const policy = new CompactTriggerPolicy();
    const decision = policy.shouldCompact({
      maxMessagesBeforeCompact: 2,
      messages: [
        { content: "hi", role: "user" },
        { content: "done", role: "assistant" }
      ],
      minTokenPressureRatio: 0.5,
      sessionScopeKey: "s1",
      taskId: "t1",
      tokenEstimate: 100,
      tokenThreshold: 1000,
      toolCallCount: 50,
      toolCallThreshold: 10
    });

    expect(decision.triggered).toBe(false);
    expect(decision.reason).toBeNull();
  });

  it("allows count triggers when minTokenPressureRatio is 0", () => {
    const policy = new CompactTriggerPolicy();
    const decision = policy.shouldCompact({
      maxMessagesBeforeCompact: 50,
      messages: [{ content: "x", role: "user" }],
      minTokenPressureRatio: 0,
      sessionScopeKey: "s1",
      taskId: "t1",
      tokenEstimate: 0,
      tokenThreshold: 999_999,
      toolCallCount: 30,
      toolCallThreshold: 20
    });

    expect(decision.triggered).toBe(true);
    expect(decision.reason).toBe("tool_call_count");
  });

  it("allows count triggers when token pressure meets minTokenPressureRatio", () => {
    const policy = new CompactTriggerPolicy();
    const decision = policy.shouldCompact({
      maxMessagesBeforeCompact: 50,
      messages: [{ content: "x", role: "user" }],
      minTokenPressureRatio: 0.5,
      sessionScopeKey: "s1",
      taskId: "t1",
      tokenEstimate: 600,
      tokenThreshold: 1000,
      toolCallCount: 30,
      toolCallThreshold: 20
    });

    expect(decision.triggered).toBe(true);
    expect(decision.reason).toBe("tool_call_count");
  });

  it("skips token_budget during compact cooldown", () => {
    const policy = new CompactTriggerPolicy();
    const decision = policy.shouldCompact({
      compactCooldownRemaining: 2,
      maxMessagesBeforeCompact: 50,
      messages: [{ content: "x", role: "user" }],
      sessionScopeKey: "s1",
      taskId: "t1",
      tokenEstimate: 20_000,
      tokenThreshold: 100
    });

    expect(decision.triggered).toBe(false);
    expect(decision.reason).toBe("cooldown");
  });

  it("sets cooldown when post-compact tokens remain at or above threshold", () => {
    expect(
      resolveCompactCooldown({
        cooldownIterations: 2,
        postCompactTokens: 15_000,
        tokenThreshold: 12_800
      })
    ).toBe(2);
    expect(
      resolveCompactCooldown({
        cooldownIterations: 2,
        postCompactTokens: 8_000,
        tokenThreshold: 12_800
      })
    ).toBe(0);
    expect(
      resolveCompactCooldown({
        cooldownIterations: 0,
        postCompactTokens: 20_000,
        tokenThreshold: 12_800
      })
    ).toBe(0);
  });
});
