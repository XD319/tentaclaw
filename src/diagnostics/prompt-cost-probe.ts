import { createHash } from "node:crypto";

import { estimateConversationMessageTokens } from "../runtime/context/token-counter.js";
import type { ConversationMessage, Provider, ProviderInput, ProviderResponse } from "../types/index.js";

export interface PromptCostProbePricing {
  cacheHitPerMillion: number;
  missPerMillion: number;
}

export interface PromptCostProbeOptions {
  cacheBlockTokens?: number;
  pricing?: PromptCostProbePricing;
}

export interface PromptCostRequestRecord {
  cachedTokens: number;
  inputTokens: number;
  lcpMessageCount: number;
  requestIndex: number;
  uncachedTokens: number;
}

export interface PromptCostProbeReport {
  cacheHitRate: number;
  effectiveCostUsd: number;
  pricing: PromptCostProbePricing;
  requests: PromptCostRequestRecord[];
  totalCachedTokens: number;
  totalInputTokens: number;
  totalUncachedTokens: number;
}

const DEFAULT_PRICING: PromptCostProbePricing = {
  cacheHitPerMillion: 0.07,
  missPerMillion: 0.56
};

function hashMessage(message: ConversationMessage): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        content: message.content ?? "",
        metadata: message.metadata ?? null,
        role: message.role,
        toolCallId: message.toolCallId ?? null,
        toolCalls: message.toolCalls ?? null,
        toolName: message.toolName ?? null
      })
    )
    .digest("hex");
}

function longestCommonPrefixTokens(
  previousHashes: string[],
  currentHashes: string[],
  tokenEstimates: number[]
): { lcpMessageCount: number; lcpTokens: number } {
  let lcpMessageCount = 0;
  let lcpTokens = 0;
  const limit = Math.min(previousHashes.length, currentHashes.length);
  for (let index = 0; index < limit; index += 1) {
    if (previousHashes[index] !== currentHashes[index]) {
      break;
    }
    lcpMessageCount += 1;
    lcpTokens += tokenEstimates[index] ?? 0;
  }
  return { lcpMessageCount, lcpTokens };
}

export class PromptCostProbe implements Provider {
  public readonly name: string;
  public readonly model?: string | undefined;

  private previousHashes: string[] = [];
  private readonly records: PromptCostRequestRecord[] = [];
  private readonly cacheBlockTokens: number;
  private readonly pricing: PromptCostProbePricing;

  public constructor(
    private readonly inner: Provider,
    options: PromptCostProbeOptions = {}
  ) {
    this.name = `${inner.name}-probed`;
    this.model = inner.model;
    this.cacheBlockTokens = options.cacheBlockTokens ?? 64;
    this.pricing = options.pricing ?? DEFAULT_PRICING;
  }

  public async generate(input: ProviderInput): Promise<ProviderResponse> {
    const messages = input.messages;
    const hashes = messages.map(hashMessage);
    const tokenEstimates = messages.map((message) => estimateConversationMessageTokens(message));
    const totalInput = tokenEstimates.reduce((sum, value) => sum + value, 0);
    const { lcpMessageCount, lcpTokens } = longestCommonPrefixTokens(
      this.previousHashes,
      hashes,
      tokenEstimates
    );
    const cachedTokens =
      Math.floor(lcpTokens / this.cacheBlockTokens) * this.cacheBlockTokens;
    const uncachedTokens = Math.max(0, totalInput - cachedTokens);

    this.records.push({
      cachedTokens,
      inputTokens: totalInput,
      lcpMessageCount,
      requestIndex: this.records.length,
      uncachedTokens
    });
    this.previousHashes = hashes;

    return this.inner.generate(input);
  }

  public getReport(): PromptCostProbeReport {
    const totalInputTokens = this.records.reduce((sum, record) => sum + record.inputTokens, 0);
    const totalCachedTokens = this.records.reduce((sum, record) => sum + record.cachedTokens, 0);
    const totalUncachedTokens = Math.max(0, totalInputTokens - totalCachedTokens);
    const effectiveCostUsd =
      (totalUncachedTokens / 1_000_000) * this.pricing.missPerMillion +
      (totalCachedTokens / 1_000_000) * this.pricing.cacheHitPerMillion;

    return {
      cacheHitRate: totalInputTokens === 0 ? 0 : totalCachedTokens / totalInputTokens,
      effectiveCostUsd,
      pricing: this.pricing,
      requests: [...this.records],
      totalCachedTokens,
      totalInputTokens,
      totalUncachedTokens
    };
  }

  public reset(): void {
    this.previousHashes = [];
    this.records.length = 0;
  }
}

export function aggregateProbeReports(reports: PromptCostProbeReport[]): PromptCostProbeReport {
  if (reports.length === 0) {
    return {
      cacheHitRate: 0,
      effectiveCostUsd: 0,
      pricing: DEFAULT_PRICING,
      requests: [],
      totalCachedTokens: 0,
      totalInputTokens: 0,
      totalUncachedTokens: 0
    };
  }

  const totalInputTokens = reports.reduce((sum, report) => sum + report.totalInputTokens, 0);
  const totalCachedTokens = reports.reduce((sum, report) => sum + report.totalCachedTokens, 0);
  const totalUncachedTokens = Math.max(0, totalInputTokens - totalCachedTokens);
  const pricing = reports[0]!.pricing;
  const effectiveCostUsd =
    (totalUncachedTokens / 1_000_000) * pricing.missPerMillion +
    (totalCachedTokens / 1_000_000) * pricing.cacheHitPerMillion;

  return {
    cacheHitRate: totalInputTokens === 0 ? 0 : totalCachedTokens / totalInputTokens,
    effectiveCostUsd,
    pricing,
    requests: reports.flatMap((report) => report.requests),
    totalCachedTokens,
    totalInputTokens,
    totalUncachedTokens
  };
}
