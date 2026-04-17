import type { ProviderConfig } from "../types";

export const SUPPORTED_PROVIDER_NAMES = [
  "mock",
  "openai-compatible",
  "openai",
  "anthropic",
  "gemini",
  "openrouter",
  "ollama",
  "glm",
  "moonshot",
  "minimax",
  "qwen",
  "xai"
] as const;

export type SupportedProviderName = (typeof SUPPORTED_PROVIDER_NAMES)[number];

export type ProviderTransportKind = "anthropic-compatible" | "mock" | "openai-compatible";

export interface ProviderCatalogEntry {
  aliases: string[];
  displayName: string;
  family: ProviderTransportKind;
  name: SupportedProviderName;
  supportsConfiguration: boolean;
  supportsStreaming: boolean;
  supportsToolCalls: boolean;
  transport: ProviderTransportKind;
}

export interface ProviderManifest {
  aliases: string[];
  anthropicCompatible?:
    | {
        anthropicVersion?: string;
        defaultBaseUrl: string | null;
        defaultDisplayName: string;
        defaultModel: string;
        providerLabel?: string;
      }
    | undefined;
  displayName: string;
  family: ProviderTransportKind;
  name: SupportedProviderName;
  openAiCompatible?:
    | {
        defaultBaseUrl: string | null;
        defaultDisplayName: string;
        defaultModel: string;
        providerLabel?: string;
      }
    | undefined;
  supportsConfiguration: boolean;
  supportsStreaming: boolean;
  supportsToolCalls: boolean;
  transport: ProviderTransportKind;
}

export interface ProviderSelection {
  modelName: string | null;
  providerName: SupportedProviderName | null;
}

const DEFAULT_PROVIDER_SETTINGS: Record<SupportedProviderName, Omit<ProviderConfig, "name">> = {
  anthropic: {
    apiKey: null,
    baseUrl: "https://api.anthropic.com",
    maxRetries: 2,
    model: "claude-sonnet-4-20250514",
    timeoutMs: 30_000
  },
  gemini: {
    apiKey: null,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    maxRetries: 2,
    model: "gemini-2.5-flash",
    timeoutMs: 30_000
  },
  glm: {
    apiKey: null,
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    maxRetries: 2,
    model: "glm-4.5-air",
    timeoutMs: 30_000
  },
  "openai-compatible": {
    apiKey: null,
    baseUrl: null,
    maxRetries: 2,
    model: "gpt-4o-mini",
    timeoutMs: 30_000
  },
  openai: {
    apiKey: null,
    baseUrl: "https://api.openai.com/v1",
    maxRetries: 2,
    model: "gpt-4o-mini",
    timeoutMs: 30_000
  },
  ollama: {
    apiKey: "ollama",
    baseUrl: "http://localhost:11434/v1",
    maxRetries: 1,
    model: "llama3.2",
    timeoutMs: 60_000
  },
  openrouter: {
    apiKey: null,
    baseUrl: "https://openrouter.ai/api/v1",
    maxRetries: 2,
    model: "openai/gpt-4o-mini",
    timeoutMs: 30_000
  },
  minimax: {
    apiKey: null,
    baseUrl: "https://api.minimax.io/anthropic",
    maxRetries: 2,
    model: "MiniMax-M2.7",
    timeoutMs: 30_000
  },
  moonshot: {
    apiKey: null,
    baseUrl: "https://api.moonshot.ai/v1",
    maxRetries: 2,
    model: "kimi-k2.5",
    timeoutMs: 30_000
  },
  mock: {
    apiKey: null,
    baseUrl: null,
    maxRetries: 0,
    model: "mock-default",
    timeoutMs: 5_000
  },
  qwen: {
    apiKey: null,
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    maxRetries: 2,
    model: "qwen-plus",
    timeoutMs: 30_000
  },
  xai: {
    apiKey: null,
    baseUrl: "https://api.x.ai/v1",
    maxRetries: 2,
    model: "grok-4.20-reasoning",
    timeoutMs: 30_000
  }
};

const PROVIDER_MANIFESTS: Record<SupportedProviderName, ProviderManifest> = {
  anthropic: {
    aliases: ["claude"],
    anthropicCompatible: {
      anthropicVersion: "2023-06-01",
      defaultBaseUrl: "https://api.anthropic.com",
      defaultDisplayName: "Anthropic",
      defaultModel: "claude-sonnet-4-20250514",
      providerLabel: "Anthropic"
    },
    displayName: "Anthropic",
    family: "anthropic-compatible",
    name: "anthropic",
    supportsConfiguration: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    transport: "anthropic-compatible"
  },
  gemini: {
    aliases: ["google"],
    displayName: "Gemini",
    family: "openai-compatible",
    name: "gemini",
    openAiCompatible: {
      defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      defaultDisplayName: "Gemini",
      defaultModel: "gemini-2.5-flash",
      providerLabel: "Gemini"
    },
    supportsConfiguration: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    transport: "openai-compatible"
  },
  glm: {
    aliases: ["z.ai", "z-ai", "zhipu"],
    displayName: "GLM",
    family: "openai-compatible",
    name: "glm",
    openAiCompatible: {
      defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
      defaultDisplayName: "GLM",
      defaultModel: "glm-4.5-air",
      providerLabel: "GLM"
    },
    supportsConfiguration: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    transport: "openai-compatible"
  },
  minimax: {
    aliases: ["mini-max"],
    anthropicCompatible: {
      anthropicVersion: "2023-06-01",
      defaultBaseUrl: "https://api.minimax.io/anthropic",
      defaultDisplayName: "MiniMax",
      defaultModel: "MiniMax-M2.7",
      providerLabel: "MiniMax"
    },
    displayName: "MiniMax",
    family: "anthropic-compatible",
    name: "minimax",
    supportsConfiguration: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    transport: "anthropic-compatible"
  },
  moonshot: {
    aliases: ["kimi"],
    displayName: "Moonshot",
    family: "openai-compatible",
    name: "moonshot",
    openAiCompatible: {
      defaultBaseUrl: "https://api.moonshot.ai/v1",
      defaultDisplayName: "Moonshot",
      defaultModel: "kimi-k2.5",
      providerLabel: "Moonshot"
    },
    supportsConfiguration: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    transport: "openai-compatible"
  },
  "openai-compatible": {
    aliases: ["compatible", "custom", "custom-openai", "openai_compatible"],
    displayName: "OpenAI Compatible",
    family: "openai-compatible",
    name: "openai-compatible",
    openAiCompatible: {
      defaultBaseUrl: null,
      defaultDisplayName: "OpenAI Compatible",
      defaultModel: "gpt-4o-mini"
    },
    supportsConfiguration: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    transport: "openai-compatible"
  },
  openai: {
    aliases: ["openai-api"],
    displayName: "OpenAI",
    family: "openai-compatible",
    name: "openai",
    openAiCompatible: {
      defaultBaseUrl: "https://api.openai.com/v1",
      defaultDisplayName: "OpenAI",
      defaultModel: "gpt-4o-mini",
      providerLabel: "OpenAI"
    },
    supportsConfiguration: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    transport: "openai-compatible"
  },
  ollama: {
    aliases: ["local"],
    displayName: "Ollama",
    family: "openai-compatible",
    name: "ollama",
    openAiCompatible: {
      defaultBaseUrl: "http://localhost:11434/v1",
      defaultDisplayName: "Ollama",
      defaultModel: "llama3.2",
      providerLabel: "Ollama"
    },
    supportsConfiguration: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    transport: "openai-compatible"
  },
  openrouter: {
    aliases: ["router"],
    displayName: "OpenRouter",
    family: "openai-compatible",
    name: "openrouter",
    openAiCompatible: {
      defaultBaseUrl: "https://openrouter.ai/api/v1",
      defaultDisplayName: "OpenRouter",
      defaultModel: "openai/gpt-4o-mini",
      providerLabel: "OpenRouter"
    },
    supportsConfiguration: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    transport: "openai-compatible"
  },
  mock: {
    aliases: [],
    displayName: "Mock Provider",
    family: "mock",
    name: "mock",
    supportsConfiguration: true,
    supportsStreaming: false,
    supportsToolCalls: true,
    transport: "mock"
  },
  qwen: {
    aliases: ["aliyun", "dashscope", "tongyi"],
    displayName: "Qwen",
    family: "openai-compatible",
    name: "qwen",
    openAiCompatible: {
      defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      defaultDisplayName: "Qwen",
      defaultModel: "qwen-plus",
      providerLabel: "Qwen"
    },
    supportsConfiguration: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    transport: "openai-compatible"
  },
  xai: {
    aliases: ["grok", "x.ai"],
    displayName: "xAI",
    family: "openai-compatible",
    name: "xai",
    openAiCompatible: {
      defaultBaseUrl: "https://api.x.ai/v1",
      defaultDisplayName: "xAI",
      defaultModel: "grok-4.20-reasoning",
      providerLabel: "xAI"
    },
    supportsConfiguration: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    transport: "openai-compatible"
  }
};

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = SUPPORTED_PROVIDER_NAMES.map((name) => {
  const manifest = PROVIDER_MANIFESTS[name];
  return {
    aliases: [...manifest.aliases],
    displayName: manifest.displayName,
    family: manifest.family,
    name: manifest.name,
    supportsConfiguration: manifest.supportsConfiguration,
    supportsStreaming: manifest.supportsStreaming,
    supportsToolCalls: manifest.supportsToolCalls,
    transport: manifest.transport
  };
});

export function listProviderManifests(): ProviderManifest[] {
  return SUPPORTED_PROVIDER_NAMES.map((name) => PROVIDER_MANIFESTS[name]);
}

export function resolveProviderManifest(name: string): ProviderManifest | null {
  const normalized = normalizeProviderName(name);
  return normalized === null ? null : PROVIDER_MANIFESTS[normalized];
}

export function requireProviderManifest(name: string): ProviderManifest {
  const manifest = resolveProviderManifest(name);
  if (manifest === null) {
    throw new Error(
      `Unsupported provider "${name}". Supported providers: ${SUPPORTED_PROVIDER_NAMES.join(", ")}.`
    );
  }

  return manifest;
}

export function resolveDefaultProviderSettings(
  name: SupportedProviderName
): Omit<ProviderConfig, "name"> {
  return DEFAULT_PROVIDER_SETTINGS[name];
}

export function normalizeProviderName(name: string): SupportedProviderName | null {
  const normalized = name.trim().toLowerCase();
  if (normalized.length === 0) {
    return null;
  }

  for (const providerName of SUPPORTED_PROVIDER_NAMES) {
    if (normalized === providerName) {
      return providerName;
    }

    const manifest = PROVIDER_MANIFESTS[providerName];
    if (manifest.aliases.some((alias) => alias.toLowerCase() === normalized)) {
      return providerName;
    }
  }

  return null;
}

export function parseProviderSelection(value: string | null | undefined): ProviderSelection {
  const normalized = normalizeNullableString(value);
  if (normalized === null) {
    return {
      modelName: null,
      providerName: null
    };
  }

  const separators = ["/", ":"];
  for (const separator of separators) {
    const separatorIndex = normalized.indexOf(separator);
    if (separatorIndex <= 0) {
      continue;
    }

    const providerCandidate = normalized.slice(0, separatorIndex);
    const providerName = normalizeProviderName(providerCandidate);
    if (providerName === null) {
      continue;
    }

    const rawModelName = normalizeNullableString(normalized.slice(separatorIndex + 1));
    return {
      modelName: rawModelName,
      providerName
    };
  }

  return {
    modelName: null,
    providerName: requireSupportedProvider(normalized)
  };
}

export function resolveProviderModel(
  providerName: SupportedProviderName,
  value: string | null | undefined
): string | null {
  const normalized = normalizeNullableString(value);
  if (normalized === null) {
    return null;
  }

  const parsed = parseModelReference(normalized);
  if (parsed.providerName === null) {
    return parsed.modelName;
  }

  if (parsed.providerName !== providerName) {
    throw new Error(
      `Configured model reference "${normalized}" does not match provider "${providerName}".`
    );
  }

  return parsed.modelName;
}

function parseModelReference(value: string): ProviderSelection {
  const separators = ["/", ":"];
  for (const separator of separators) {
    const separatorIndex = value.indexOf(separator);
    if (separatorIndex <= 0) {
      continue;
    }

    const providerCandidate = value.slice(0, separatorIndex);
    const providerName = normalizeProviderName(providerCandidate);
    if (providerName === null) {
      continue;
    }

    return {
      modelName: normalizeNullableString(value.slice(separatorIndex + 1)),
      providerName
    };
  }

  return {
    modelName: value,
    providerName: null
  };
}

function requireSupportedProvider(value: string): SupportedProviderName {
  const normalized = normalizeProviderName(value);
  if (normalized === null) {
    throw new Error(
      `Unsupported provider "${value}". Supported providers: ${SUPPORTED_PROVIDER_NAMES.join(", ")}.`
    );
  }

  return normalized;
}

function normalizeNullableString(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}
