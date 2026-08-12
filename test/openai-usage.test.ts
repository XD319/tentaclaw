import { describe, expect, it } from "vitest";

import { parseOpenAiCompatibleUsage } from "../src/providers/openai-usage.js";
import { ProviderTelemetry } from "../src/providers/provider-telemetry.js";
import { computeCostUsd } from "../src/runtime/budget/cost-calculator.js";

describe("parseOpenAiCompatibleUsage", () => {
  it("maps OpenAI prompt_tokens_details.cached_tokens", () => {
    expect(
      parseOpenAiCompatibleUsage({
        completion_tokens: 20,
        prompt_tokens: 100,
        prompt_tokens_details: { cached_tokens: 80 },
        total_tokens: 120
      })
    ).toEqual({
      cachedInputTokens: 80,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120
    });
  });

  it("maps DeepSeek-style prompt_cache_hit_tokens", () => {
    expect(
      parseOpenAiCompatibleUsage({
        completion_tokens: 5,
        prompt_cache_hit_tokens: 40,
        prompt_tokens: 50
      })
    ).toEqual({
      cachedInputTokens: 40,
      inputTokens: 50,
      outputTokens: 5
    });
  });

  it("maps top-level cached_tokens when nested details are absent", () => {
    expect(
      parseOpenAiCompatibleUsage({
        cached_tokens: 12,
        completion_tokens: 3,
        prompt_tokens: 30
      }).cachedInputTokens
    ).toBe(12);
  });

  it("omits cachedInputTokens when no cache fields are present", () => {
    expect(
      parseOpenAiCompatibleUsage({
        completion_tokens: 1,
        prompt_tokens: 2,
        total_tokens: 3
      })
    ).toEqual({
      inputTokens: 2,
      outputTokens: 1,
      totalTokens: 3
    });
  });

  it("ignores negative or non-finite cache values", () => {
    expect(
      parseOpenAiCompatibleUsage({
        prompt_tokens: 10,
        prompt_tokens_details: { cached_tokens: -1 },
        completion_tokens: 1
      }).cachedInputTokens
    ).toBeUndefined();
  });
});

describe("cached token telemetry path", () => {
  it("aggregates cachedInputTokens into provider stats and cost", () => {
    const telemetry = new ProviderTelemetry("openai");
    const usage = parseOpenAiCompatibleUsage({
      completion_tokens: 10,
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 70 },
      total_tokens: 110
    });

    telemetry.recordSuccess(25, usage, 0);
    const snapshot = telemetry.snapshot();

    expect(snapshot.tokenUsage.cachedInputTokens).toBe(70);
    expect(
      computeCostUsd(snapshot.tokenUsage, {
        cachedInputPerMillion: 0.5,
        inputPerMillion: 1,
        outputPerMillion: 2
      })
    ).toBeCloseTo(0.000155, 8);
  });
});
