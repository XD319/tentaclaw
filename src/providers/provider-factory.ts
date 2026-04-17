import type { Provider } from "../types";

import { MockProvider } from "./mock-provider";
import type { ResolvedProviderConfig } from "./config";
import { GlmProvider } from "./glm-provider";
import { ManagedProvider } from "./provider-runtime";

export function createProvider(config: ResolvedProviderConfig): Provider {
  const provider = config.name === "glm" ? new GlmProvider(config) : new MockProvider(config);

  return new ManagedProvider(provider, config);
}
