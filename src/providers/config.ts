import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { JsonObject, ProviderConfig } from "../types/index.js";
import {
  PROVIDER_CATALOG,
  type ProviderCatalogEntry,
  type ProviderTransportKind,
  type SupportedProviderName,
  normalizeProviderName,
  parseProviderSelection,
  resolveDefaultProviderSettings,
  requireProviderManifest,
  resolveProviderModel
} from "./provider-registry.js";

interface ProviderFileEntry extends JsonObject {
  apiKey?: string | null;
  baseUrl?: string | null;
  maxRetries?: number;
  model?: string | null;
  timeoutMs?: number;
}

interface CustomProviderFileEntry extends ProviderFileEntry {
  anthropicVersion?: string | null;
  displayName?: string | null;
  providerLabel?: string | null;
  transport?: Exclude<ProviderTransportKind, "mock">;
}

interface ProviderConfigFile extends JsonObject {
  currentProvider?: string;
  customProviders?: Record<string, CustomProviderFileEntry>;
  providers?: Record<string, ProviderFileEntry>;
}

export interface ResolvedProviderConfig extends ProviderConfig {
  anthropicVersion?: string | null;
  builtinProviderName: SupportedProviderName | null;
  configPath: string;
  configSource: "defaults" | "env" | "file";
  displayName: string;
  family: ProviderTransportKind;
  providerLabel?: string | null;
  transport: ProviderTransportKind;
}

export function resolveProviderConfig(cwd = process.cwd()): ResolvedProviderConfig {
  const configPath = join(resolve(cwd), ".auto-talon", "provider.config.json");
  const fileConfig = loadProviderConfigFile(configPath);
  const customProviders = normalizeCustomProviders(fileConfig.customProviders);
  const providerEntries = normalizeProviderEntries(fileConfig.providers, customProviders);
  const providerSelection = resolveConfiguredProviderSelection(
    process.env.AGENT_PROVIDER ?? fileConfig.currentProvider,
    customProviders
  );
  const configuredName = providerSelection.providerName ?? "mock";
  const fileEntry = providerEntries[configuredName];
  const customProvider = customProviders[configuredName];
  const builtinProviderName = normalizeProviderName(configuredName);

  let configSource: ResolvedProviderConfig["configSource"] = "defaults";
  if (fileConfig.currentProvider !== undefined || fileEntry !== undefined) {
    configSource = "file";
  }

  if (
    process.env.AGENT_PROVIDER !== undefined ||
    process.env.AGENT_PROVIDER_MODEL !== undefined ||
    process.env.AGENT_PROVIDER_BASE_URL !== undefined ||
    process.env.AGENT_PROVIDER_API_KEY !== undefined ||
    process.env.AGENT_PROVIDER_TIMEOUT_MS !== undefined ||
    process.env.AGENT_PROVIDER_MAX_RETRIES !== undefined
  ) {
    configSource = "env";
  }

  if (builtinProviderName !== null) {
    const manifest = requireProviderManifest(builtinProviderName);
    const defaults = resolveDefaultProviderSettings(builtinProviderName);
    const model = resolveProviderModel(
      builtinProviderName,
      process.env.AGENT_PROVIDER_MODEL ??
        fileEntry?.model ??
        providerSelection.modelName ??
        defaults.model
    );

    return {
      apiKey: normalizeNullableString(
        process.env.AGENT_PROVIDER_API_KEY ?? fileEntry?.apiKey ?? defaults.apiKey
      ),
      baseUrl: normalizeNullableString(
        process.env.AGENT_PROVIDER_BASE_URL ?? fileEntry?.baseUrl ?? defaults.baseUrl
      ),
      builtinProviderName,
      configPath,
      configSource,
      maxRetries: normalizePositiveNumber(
        process.env.AGENT_PROVIDER_MAX_RETRIES ?? fileEntry?.maxRetries,
        defaults.maxRetries
      ),
      model,
      name: configuredName,
      displayName: manifest.displayName,
      family: manifest.family,
      timeoutMs: normalizePositiveNumber(
        process.env.AGENT_PROVIDER_TIMEOUT_MS ?? fileEntry?.timeoutMs,
        defaults.timeoutMs
      ),
      transport: manifest.transport
    };
  }

  if (customProvider === undefined) {
    throw new Error(`Unsupported provider "${configuredName}".`);
  }

  const model = resolveCustomProviderModel(
    configuredName,
    process.env.AGENT_PROVIDER_MODEL ??
      fileEntry?.model ??
      providerSelection.modelName ??
      customProvider.model
  );

  return {
    anthropicVersion: normalizeNullableString(customProvider.anthropicVersion),
    apiKey: normalizeNullableString(
      process.env.AGENT_PROVIDER_API_KEY ?? fileEntry?.apiKey ?? customProvider.apiKey
    ),
    baseUrl: normalizeNullableString(
      process.env.AGENT_PROVIDER_BASE_URL ?? fileEntry?.baseUrl ?? customProvider.baseUrl
    ),
    builtinProviderName: null,
    configPath,
    configSource,
    maxRetries: normalizePositiveNumber(
      process.env.AGENT_PROVIDER_MAX_RETRIES ?? fileEntry?.maxRetries,
      normalizePositiveNumber(customProvider.maxRetries, 2)
    ),
    model,
    name: configuredName,
    displayName: normalizeNullableString(customProvider.displayName) ?? configuredName,
    family: customProvider.transport,
    providerLabel:
      normalizeNullableString(customProvider.providerLabel) ??
      normalizeNullableString(customProvider.displayName) ??
      configuredName,
    timeoutMs: normalizePositiveNumber(
      process.env.AGENT_PROVIDER_TIMEOUT_MS ?? fileEntry?.timeoutMs,
      normalizePositiveNumber(customProvider.timeoutMs, 30_000)
    ),
    transport: customProvider.transport
  };
}

export function resolveProviderCatalog(cwd = process.cwd()): ProviderCatalogEntry[] {
  const configPath = join(resolve(cwd), ".auto-talon", "provider.config.json");
  const fileConfig = loadProviderConfigFile(configPath);
  const customProviders = normalizeCustomProviders(fileConfig.customProviders);

  return [
    ...PROVIDER_CATALOG,
    ...Object.entries(customProviders).map(([name, provider]) => ({
      aliases: [],
      displayName: normalizeNullableString(provider.displayName) ?? name,
      family: provider.transport,
      name,
      supportsConfiguration: true,
      supportsStreaming: true,
      supportsToolCalls: true,
      transport: provider.transport
    }))
  ];
}

export function maskSecret(secret: string | null): string {
  if (secret === null || secret.length === 0) {
    return "missing";
  }

  if (secret.length <= 6) {
    return "***";
  }

  return `${secret.slice(0, 3)}***${secret.slice(-2)}`;
}

function loadProviderConfigFile(configPath: string): ProviderConfigFile {
  if (!existsSync(configPath)) {
    return {};
  }

  const content = readFileSync(configPath, "utf8").trim();
  if (content.length === 0) {
    return {};
  }

  const parsed = JSON.parse(content) as ProviderConfigFile;
  return parsed;
}

function normalizeProviderEntries(
  providers: Record<string, ProviderFileEntry> | undefined,
  customProviders: Record<string, CustomProviderFileEntry>
): Record<string, ProviderFileEntry> {
  if (providers === undefined) {
    return {};
  }

  return Object.entries(providers).reduce<Record<string, ProviderFileEntry>>((entries, [key, value]) => {
      if (customProviders[key] !== undefined) {
        entries[key] = {
          ...(entries[key] ?? {}),
          ...value
        };
        return entries;
      }

      const normalized = normalizeProviderName(key);
      if (normalized === null) {
        return entries;
      }

      entries[normalized] = {
        ...(entries[normalized] ?? {}),
        ...value
      };
      return entries;
    }, {});
}

function normalizeCustomProviders(
  providers: Record<string, CustomProviderFileEntry> | undefined
): Record<string, CustomProviderFileEntry & { transport: Exclude<ProviderTransportKind, "mock"> }> {
  if (providers === undefined) {
    return {};
  }

  return Object.entries(providers).reduce<
    Record<string, CustomProviderFileEntry & { transport: Exclude<ProviderTransportKind, "mock"> }>
  >((entries, [key, value]) => {
    const name = key.trim();
    if (name.length === 0) {
      return entries;
    }

    if (normalizeProviderName(name) !== null) {
      return entries;
    }

    if (value.transport !== "openai-compatible" && value.transport !== "anthropic-compatible") {
      return entries;
    }

    entries[name] = {
      ...value,
      transport: value.transport
    };
    return entries;
  }, {});
}

function resolveConfiguredProviderSelection(
  value: string | null | undefined,
  customProviders: Record<string, CustomProviderFileEntry>
): { modelName: string | null; providerName: string | null } {
  try {
    const parsed = parseProviderSelection(value);
    if (parsed.providerName !== null) {
      return parsed;
    }
  } catch {
    // Fall through to custom provider resolution.
  }

  const normalized = normalizeNullableString(value);
  if (normalized === null) {
    return {
      modelName: null,
      providerName: null
    };
  }

  for (const separator of ["/", ":"]) {
    const separatorIndex = normalized.indexOf(separator);
    if (separatorIndex <= 0) {
      continue;
    }

    const providerCandidate = normalized.slice(0, separatorIndex);
    if (customProviders[providerCandidate] === undefined) {
      continue;
    }

    return {
      modelName: normalizeNullableString(normalized.slice(separatorIndex + 1)),
      providerName: providerCandidate
    };
  }

  if (customProviders[normalized] !== undefined) {
    return {
      modelName: null,
      providerName: normalized
    };
  }

  throw new Error(`Unsupported provider "${normalized}".`);
}

function resolveCustomProviderModel(
  providerName: string,
  value: string | null | undefined
): string | null {
  const normalized = normalizeNullableString(value);
  if (normalized === null) {
    return null;
  }

  for (const separator of ["/", ":"]) {
    const separatorIndex = normalized.indexOf(separator);
    if (separatorIndex <= 0) {
      continue;
    }

    if (normalized.slice(0, separatorIndex) !== providerName) {
      continue;
    }

    return normalizeNullableString(normalized.slice(separatorIndex + 1));
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

function normalizePositiveNumber(value: number | string | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return fallback;
}
