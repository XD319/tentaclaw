import { AnthropicCompatibleProvider } from "./anthropic-compatible-provider";
import type { Provider } from "../types";

import { MockProvider } from "./mock-provider";
import { OpenAiCompatibleProvider } from "./openai-compatible-provider";
import type { ResolvedProviderConfig } from "./config";
import { requireProviderManifest } from "./provider-registry";
import { ManagedProvider } from "./provider-runtime";

export function createProvider(config: ResolvedProviderConfig): Provider {
  const manifest = requireProviderManifest(config.name);
  const provider = createProviderInstance(config, manifest);

  return new ManagedProvider(provider, config);
}

function createProviderInstance(
  config: ResolvedProviderConfig,
  manifest: ReturnType<typeof requireProviderManifest>
): Provider {
  if (manifest.transport === "mock") {
    return new MockProvider(config);
  }

  if (
    manifest.transport === "anthropic-compatible" &&
    manifest.anthropicCompatible !== undefined
  ) {
    return new AnthropicCompatibleProvider(config, manifest.anthropicCompatible);
  }

  if (manifest.transport === "openai-compatible" && manifest.openAiCompatible !== undefined) {
    return new OpenAiCompatibleProvider(config, manifest.openAiCompatible);
  }

  throw new Error(`Provider ${manifest.name} has no runtime transport implementation.`);
}
