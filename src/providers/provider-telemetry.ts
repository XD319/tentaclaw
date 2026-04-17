import type { ProviderErrorCategory, ProviderStatsSnapshot, ProviderUsage } from "../types";

const EMPTY_USAGE: ProviderUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0
};

export class ProviderTelemetry {
  private failedRequests = 0;
  private lastErrorCategory: ProviderErrorCategory | null = null;
  private lastRequestAt: string | null = null;
  private successfulRequests = 0;
  private totalLatencyMs = 0;
  private totalRequests = 0;
  private totalRetries = 0;
  private tokenUsage: ProviderUsage = { ...EMPTY_USAGE };

  public constructor(private readonly providerName: string) {}

  public recordFailure(latencyMs: number, category: ProviderErrorCategory, retryCount: number): void {
    this.totalRequests += 1;
    this.failedRequests += 1;
    this.totalLatencyMs += latencyMs;
    this.totalRetries += retryCount;
    this.lastErrorCategory = category;
    this.lastRequestAt = new Date().toISOString();
  }

  public recordSuccess(latencyMs: number, usage: ProviderUsage, retryCount: number): void {
    this.totalRequests += 1;
    this.successfulRequests += 1;
    this.totalLatencyMs += latencyMs;
    this.totalRetries += retryCount;
    this.lastRequestAt = new Date().toISOString();
    this.tokenUsage = mergeUsage(this.tokenUsage, usage);
  }

  public snapshot(): ProviderStatsSnapshot {
    return {
      averageLatencyMs:
        this.totalRequests === 0 ? 0 : Number((this.totalLatencyMs / this.totalRequests).toFixed(2)),
      failedRequests: this.failedRequests,
      lastErrorCategory: this.lastErrorCategory,
      lastRequestAt: this.lastRequestAt,
      providerName: this.providerName,
      retryCount: this.totalRetries,
      successfulRequests: this.successfulRequests,
      tokenUsage: { ...this.tokenUsage },
      totalRequests: this.totalRequests
    };
  }
}

function mergeUsage(current: ProviderUsage, next: ProviderUsage): ProviderUsage {
  const totalTokens =
    (current.totalTokens ?? current.inputTokens + current.outputTokens) +
    (next.totalTokens ?? next.inputTokens + next.outputTokens);

  return {
    cachedInputTokens: (current.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0),
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    totalTokens
  };
}
