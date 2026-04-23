import type { ProviderUsage } from "../types/index.js";

/** Rough placeholder pricing (USD per 1M tokens) for status estimates; override with env if needed. */
export function estimateSessionCostUsd(
  providerName: string,
  modelName: string | undefined,
  usage: ProviderUsage
): number {
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  const key = `${providerName}:${modelName ?? ""}`.toLowerCase();

  let inPerM = 3;
  let outPerM = 15;

  if (key.includes("gpt-4o-mini")) {
    inPerM = 0.15;
    outPerM = 0.6;
  } else if (key.includes("gpt-4o")) {
    inPerM = 2.5;
    outPerM = 10;
  } else if (key.includes("haiku") || key.includes("3-5-haiku")) {
    inPerM = 0.25;
    outPerM = 1.25;
  } else if (key.includes("sonnet") || key.includes("3-5-sonnet")) {
    inPerM = 3;
    outPerM = 15;
  } else if (key.includes("opus")) {
    inPerM = 15;
    outPerM = 75;
  }

  const custom = process.env.AGENT_TOKEN_PRICE_IN_PER_M;
  const customOut = process.env.AGENT_TOKEN_PRICE_OUT_PER_M;
  if (custom !== undefined && customOut !== undefined) {
    inPerM = Number(custom);
    outPerM = Number(customOut);
  }

  return (input * inPerM + output * outPerM) / 1_000_000;
}

export function contextWindowPercent(usage: ProviderUsage, inputLimit: number, outputLimit: number): number {
  const used = usage.inputTokens + usage.outputTokens;
  const cap = Math.max(inputLimit + outputLimit, 1);
  return Math.min(100, Math.round((used / cap) * 100));
}

export function contextUsageColor(percent: number): "green" | "yellow" | "red" {
  if (percent < 50) {
    return "green";
  }
  if (percent < 80) {
    return "yellow";
  }
  return "red";
}
