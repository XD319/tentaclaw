import type { ProviderConfig } from "../types/index.js";

import { OpenAiCompatibleProvider } from "./openai-compatible-provider.js";
import { requireProviderManifest } from "./provider-registry.js";

export class GlmProvider extends OpenAiCompatibleProvider {
  public constructor(config: ProviderConfig) {
    super(config, requireProviderManifest("glm").openAiCompatible ?? {
      defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
      defaultDisplayName: "GLM",
      defaultModel: "glm-4.5-air",
      providerLabel: "GLM"
    });
  }
}
