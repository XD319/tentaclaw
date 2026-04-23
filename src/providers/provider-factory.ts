import { AnthropicCompatibleProvider } from "./anthropic-compatible-provider.js";
import type { Provider } from "../types/index.js";

import { MockProvider } from "./mock-provider.js";
import { OpenAiCompatibleProvider } from "./openai-compatible-provider.js";
import type { ResolvedProviderConfig } from "./config.js";
import { requireProviderManifest } from "./provider-registry.js";
import { ManagedProvider } from "./provider-runtime.js";

export function createProvider(config: ResolvedProviderConfig): Provider {
  const manifest =
    config.builtinProviderName === null ? null : requireProviderManifest(config.builtinProviderName);
  const provider = createProviderInstance(config, manifest);

  return new ManagedProvider(provider, config);
}

function createProviderInstance(
  config: ResolvedProviderConfig,
  manifest: ReturnType<typeof requireProviderManifest> | null
): Provider {
  if (manifest === null) {
    if (config.transport === "anthropic-compatible") {
      const options: ConstructorParameters<typeof AnthropicCompatibleProvider>[1] = {
        defaultBaseUrl: config.baseUrl,
        defaultDisplayName: config.displayName,
        defaultModel: config.model ?? "custom-anthropic-model",
        providerLabel: config.providerLabel ?? config.displayName
      };
      if (config.anthropicVersion !== null && config.anthropicVersion !== undefined) {
        options.anthropicVersion = config.anthropicVersion;
      }

      return new AnthropicCompatibleProvider(config, options);
    }

    if (config.transport === "openai-compatible") {
      return new OpenAiCompatibleProvider(config, {
        defaultBaseUrl: config.baseUrl,
        defaultDisplayName: config.displayName,
        defaultModel: config.model ?? "custom-openai-compatible-model",
        providerLabel: config.providerLabel ?? config.displayName
      });
    }

    throw new Error(`Provider ${config.name} has no runtime transport implementation.`);
  }

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
    return new OpenAiCompatibleProvider(config, {
      ...manifest.openAiCompatible,
      supportsStreaming: manifest.supportsStreaming
    });
  }

  throw new Error(`Provider ${manifest.name} has no runtime transport implementation.`);
}
