import type { ProviderUsage } from "../types/index.js";

export interface OpenAiCompatibleUsageRaw {
  completion_tokens?: number;
  prompt_tokens?: number;
  total_tokens?: number;
  /**
   * OpenAI-style nested cache hit count.
   * https://platform.openai.com/docs/api-reference/chat/object
   */
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  /** Some gateways expose cached tokens at the top level. */
  cached_tokens?: number;
  /** DeepSeek / several OpenAI-compatible vendors. */
  prompt_cache_hit_tokens?: number;
}

/**
 * Map OpenAI-compatible usage payloads into AutoTalon ProviderUsage,
 * including cache-hit fields when the upstream reports them.
 */
export function parseOpenAiCompatibleUsage(
  rawUsage: OpenAiCompatibleUsageRaw | undefined
): ProviderUsage {
  const usage: ProviderUsage = {
    inputTokens: rawUsage?.prompt_tokens ?? 0,
    outputTokens: rawUsage?.completion_tokens ?? 0
  };

  if (rawUsage?.total_tokens !== undefined) {
    usage.totalTokens = rawUsage.total_tokens;
  }

  const cachedInputTokens = readCachedInputTokens(rawUsage);
  if (cachedInputTokens !== undefined) {
    usage.cachedInputTokens = cachedInputTokens;
  }

  return usage;
}

function readCachedInputTokens(rawUsage: OpenAiCompatibleUsageRaw | undefined): number | undefined {
  if (rawUsage === undefined) {
    return undefined;
  }

  const candidates = [
    rawUsage.prompt_tokens_details?.cached_tokens,
    rawUsage.prompt_cache_hit_tokens,
    rawUsage.cached_tokens
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      return candidate;
    }
  }

  return undefined;
}
