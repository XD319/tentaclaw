import type { ProviderTier, RoutingMode } from "../../types/index.js";

export function tierFor(mode: RoutingMode, fallback: ProviderTier = "balanced"): ProviderTier {
  if (mode === "cheap_first") {
    return "cheap";
  }
  if (mode === "quality_first") {
    return "quality";
  }
  if (mode === "balanced") {
    return "balanced";
  }
  return fallback;
}
