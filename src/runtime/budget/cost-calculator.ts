import type { BudgetPricingEntry, ProviderUsage } from "../../types/index.js";

export function computeCostUsd(
  usage: ProviderUsage,
  pricing: BudgetPricingEntry | null | undefined
): number | null {
  if (pricing === null || pricing === undefined) {
    return null;
  }
  const input = (usage.inputTokens / 1_000_000) * pricing.inputPerMillion;
  const output = (usage.outputTokens / 1_000_000) * pricing.outputPerMillion;
  const cachedInput =
    pricing.cachedInputPerMillion === undefined || usage.cachedInputTokens === undefined
      ? 0
      : (usage.cachedInputTokens / 1_000_000) * pricing.cachedInputPerMillion;
  const total = input + output + cachedInput;
  return Number.isFinite(total) ? Number(total.toFixed(8)) : null;
}
