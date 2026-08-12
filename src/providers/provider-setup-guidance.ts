/**
 * Next-step guidance for provider setup / status / test failure paths.
 */

export function providerRequiresApiKey(providerName: string): boolean {
  const normalized = providerName.trim().toLowerCase();
  return normalized !== "mock" && normalized !== "ollama" && normalized !== "unconfigured";
}

export function missingApiKeyMessage(displayName: string, providerName: string): string {
  return (
    `Missing API key for ${displayName}. ` +
    `Next: talon provider setup ${providerName} --api-key <key> or set AGENT_PROVIDER_API_KEY.`
  );
}

export function unconfiguredProviderMessage(): string {
  return (
    "No provider is configured. " +
    "Next: talon provider setup mock (no credentials) or talon provider setup <provider> --api-key <key>."
  );
}

export function formatProviderSetupNextSteps(input: {
  apiKeyProvided: boolean;
  baseUrlProvided: boolean;
  contextWindowTokens?: number;
  modelProvided: boolean;
  providerName: string;
}): string[] {
  const lines: string[] = [];
  const name = input.providerName;

  if (providerRequiresApiKey(name) && !input.apiKeyProvided) {
    lines.push(
      `Warning: no --api-key was provided. Next: talon provider setup ${name} --api-key <key> (or set AGENT_PROVIDER_API_KEY), then talon provider test.`
    );
  }

  if (name === "openai-compatible") {
    if (!input.baseUrlProvided || !input.modelProvided) {
      lines.push(
        "Warning: openai-compatible usually needs --base-url and --model. Next: talon provider setup openai-compatible --base-url <url> --model <model> --api-key <key>."
      );
    }
  }

  if (input.contextWindowTokens === undefined && name !== "mock") {
    lines.push(
      `Note: context window unset. If status shows "Context Window Tokens: -", set it with talon provider setup ${name} --context-window-tokens <n>.`
    );
  }

  lines.push("Check: talon provider status");
  lines.push("Test: talon provider test");
  return lines;
}

export function formatProviderHealthNextSteps(report: {
  apiKeyConfigured: boolean;
  endpointReachable: boolean | null;
  message: string;
  modelAvailable: boolean | null;
  modelConfigured: boolean;
  ok: boolean;
  providerName: string;
}): string | null {
  if (report.ok) {
    return null;
  }

  if (report.message.includes("No provider is configured")) {
    return "Next: talon provider setup mock (no credentials), or talon provider setup <provider> --api-key <key>. See docs/troubleshooting/provider.md.";
  }

  if (!report.apiKeyConfigured && providerRequiresApiKey(report.providerName)) {
    return `Next: talon provider setup ${report.providerName} --api-key <key> (or set AGENT_PROVIDER_API_KEY), then re-run talon provider test.`;
  }

  if (report.endpointReachable === false) {
    return `Next: verify network / base URL, then talon provider setup ${report.providerName} --base-url <url> and re-run talon provider test.`;
  }

  if (report.modelConfigured === false) {
    return `Next: talon provider setup ${report.providerName} --model <model>, then re-run talon provider test.`;
  }

  if (report.modelAvailable === false) {
    return `Next: choose a model listed by the provider with talon provider setup ${report.providerName} --model <model>.`;
  }

  return "Next: run talon provider status and see docs/troubleshooting/provider.md.";
}

export function formatProviderStatusNextSteps(config: {
  builtinProviderName?: string | null;
  configured?: boolean;
  contextWindowTokens?: number | null;
  name: string;
  transport?: string;
}): string[] {
  const lines: string[] = [];

  if (config.configured === false) {
    lines.push("Setup Required: yes");
    lines.push("Next: talon provider setup mock  # no-credentials demo");
    lines.push("Or: talon provider setup <provider> --api-key <key>");
    return lines;
  }

  if (
    (config.contextWindowTokens === null || config.contextWindowTokens === undefined) &&
    config.transport !== "mock" &&
    config.builtinProviderName !== "mock"
  ) {
    lines.push(
      `Next: context window is unknown; set talon provider setup ${config.name} --context-window-tokens <n> if compaction/budget behavior looks wrong.`
    );
  }

  return lines;
}
