import type { ProviderConfig } from "../types/index.js";

import { AnthropicCompatibleProvider } from "./anthropic-compatible-provider.js";
import { requireProviderManifest } from "./provider-registry.js";

export class AnthropicProvider extends AnthropicCompatibleProvider {
  public constructor(config: ProviderConfig) {
    super(config, requireProviderManifest("anthropic").anthropicCompatible ?? {
      anthropicVersion: "2023-06-01",
      defaultBaseUrl: "https://api.anthropic.com",
      defaultDisplayName: "Anthropic",
      defaultModel: "claude-sonnet-4-20250514",
      providerLabel: "Anthropic"
    });
  }
}
