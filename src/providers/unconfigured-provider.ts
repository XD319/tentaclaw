import type { Provider, ProviderDescriptor, ProviderHealthCheck, ProviderResponse } from "../types/index.js";

import type { ResolvedProviderConfig } from "./config.js";
import { createProviderError } from "./provider-runtime.js";
import { unconfiguredProviderMessage } from "./provider-setup-guidance.js";

export class UnconfiguredProvider implements Provider {
  public readonly capabilities = {
    streaming: false,
    textGeneration: false,
    toolCalls: false
  } as const;

  public readonly name: string;

  public constructor(private readonly config: ResolvedProviderConfig) {
    this.name = config.name;
  }

  public describe(): ProviderDescriptor {
    return {
      baseUrl: null,
      capabilities: this.capabilities,
      displayName: this.config.displayName,
      model: null,
      name: this.name
    };
  }

  public testConnection(): Promise<ProviderHealthCheck> {
    return Promise.resolve({
      apiKeyConfigured: false,
      endpointReachable: null,
      message: unconfiguredProviderMessage(),
      modelAvailable: null,
      modelConfigured: false,
      modelName: null,
      ok: false,
      providerName: this.name
    });
  }

  public generate(): Promise<ProviderResponse> {
    throw createProviderError({
      category: "invalid_request",
      message: unconfiguredProviderMessage(),
      providerName: this.name,
      retriable: false,
      summary: "Provider setup is required before running tasks."
    });
  }
}
