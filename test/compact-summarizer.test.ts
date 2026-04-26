import { describe, expect, it } from "vitest";

import {
  DeterministicCompactSummarizer,
  ProviderSubagentSummarizer
} from "../src/memory/compact-summarizer.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/types/index.js";

class FinalSummaryProvider implements Provider {
  public readonly name = "final-summary-provider";

  public generate(_input: ProviderRequest): Promise<ProviderResponse> {
    return Promise.resolve({
      kind: "final",
      message:
        "goal=Ship feature\nlatest_user_request=continue\ncompletedWork=done\nfilesTouched=src/app.ts\ncommandsRun=npm test\nblockers=[none]\nnextActions=commit\ntool_signals=ok",
      usage: { inputTokens: 1, outputTokens: 1 }
    });
  }
}

class ThrowingSummaryProvider implements Provider {
  public readonly name = "throwing-summary-provider";

  public generate(_input: ProviderRequest): Promise<ProviderResponse> {
    throw new Error("provider failed");
  }
}

describe("compact summarizer", () => {
  const compactInput = {
    maxMessagesBeforeCompact: 8,
    messages: [
      { content: "Deploy with apiKey=sk-abcdef1234567890 and ping me at test@example.com", role: "user" as const },
      {
        content: "I will run shell next and then verify tests",
        role: "assistant" as const
      },
      {
        content:
          "{\"command\":\"npm test\",\"path\":\"src/app.ts\",\"stderr\":\"error: timeout\",\"stdout\":\"done\"}",
        role: "tool" as const,
        toolCallId: "tc-1",
        toolName: "Shell"
      },
      {
        content: "Next I should update docs and commit",
        role: "assistant" as const
      }
    ],
    reason: "message_count" as const,
    sessionScopeKey: "thread-1",
    taskId: "task-1"
  };

  it("builds structured deterministic summary and redacts sensitive values", async () => {
    const summarizer = new DeterministicCompactSummarizer();
    const result = await summarizer.summarize(compactInput);
    expect(result.summarizerId).toBe("deterministic");
    expect(result.summary).toContain("completedWork=");
    expect(result.summary).toContain("filesTouched=");
    expect(result.summary).toContain("commandsRun=");
    expect(result.summary).toContain("blockers=");
    expect(result.summary).toContain("nextActions=");
    expect(result.summary).toContain("apiKey=[REDACTED]");
    expect(result.summary).toContain("[REDACTED_EMAIL]");
  });

  it("uses provider_subagent output when provider succeeds", async () => {
    const summarizer = new ProviderSubagentSummarizer(() => new FinalSummaryProvider());
    const result = await summarizer.summarize(compactInput);
    expect(result.summarizerId).toContain("provider_subagent:final-summary-provider");
    expect(result.fallbackReason).toBeUndefined();
    expect(result.summary).toContain("completedWork=done");
  });

  it("falls back to deterministic summary when provider_subagent fails", async () => {
    const summarizer = new ProviderSubagentSummarizer(() => new ThrowingSummaryProvider());
    const result = await summarizer.summarize(compactInput);
    expect(result.summarizerId).toContain("fallback_deterministic");
    expect(result.fallbackReason).toBe("provider_error");
    expect(result.summary).toContain("commandsRun=");
  });
});
