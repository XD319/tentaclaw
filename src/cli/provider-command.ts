import type { Command } from "commander";

import {
  addFallbackProviderConfig,
  addModelAliasConfig,
  addProviderCredentialEnvConfig,
  clearFallbackProviderConfig,
  listProviderCredentialConfig,
  promoteProviderConfig,
  removeCustomProviderConfig,
  removeFallbackProviderConfig,
  removeModelAliasConfig,
  removeProviderCredentialConfig,
  resolveMergedFallbackProviders,
  resolveMergedFallbackProvidersForSlot,
  resolveMergedModelAliases,
  setupCustomProviderConfig,
  setupProviderConfig,
  setProviderCredentialEnabledConfig,
  useProviderConfig,
  type ProviderConfigScope,
  type ProviderConfigWriteResult
} from "../providers/index.js";
import { listModelAliasEntries } from "../providers/model-aliases.js";
import { createApplication, resolveAppConfig } from "../runtime/index.js";
import {
  formatCurrentProvider,
  formatProviderCatalog,
  formatProviderHealth,
  formatProviderSmoke,
  formatProviderStats
} from "./formatters.js";
import { parseNonNegativeIntegerOption, parsePositiveIntegerOption } from "./cli-helpers.js";
import { formatProviderSetupNextSteps } from "../providers/provider-setup-guidance.js";

interface ProviderSetupCommandOptions {
  apiKey?: string;
  baseUrl?: string;
  contextWindowTokens?: number;
  maxRetries?: number;
  model?: string;
  streamIdleTimeoutMs?: number;
  timeoutMs?: number;
  workspace?: boolean;
}

interface ProviderUseCommandOptions {
  workspace?: boolean;
}

export function registerProviderCommands(program: Command): void {
  const providerCommand = program.command("provider").description("Configure, inspect, and test providers");

  providerCommand.command("list").option("--json", "Print JSON").action((commandOptions: { json?: boolean }) => {
    const handle = createApplication(process.cwd());
    try {
      const providers = handle.service.listProviders();
      console.log(commandOptions.json === true
        ? JSON.stringify(providers, null, 2)
        : formatProviderCatalog(handle.service.currentProvider().name, providers));
    } finally {
      handle.close();
    }
  });

  const printCurrentProvider = (): void => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatCurrentProvider(handle.service.currentProvider()));
    } finally {
      handle.close();
    }
  };

  providerCommand.command("current").description("Show the active provider").action(printCurrentProvider);
  providerCommand.command("status").description("Show provider setup status").action(printCurrentProvider);

  providerCommand
    .command("setup")
    .description("Configure a provider in reusable user config")
    .argument("<provider>", "Provider name; provider:model also sets the model")
    .option("--api-key <key>", "API key to store in provider config")
    .option("--base-url <url>", "Provider base URL")
    .option("--context-window-tokens <number>", "Provider/model context window in tokens", parsePositiveIntegerOption("--context-window-tokens"))
    .option("--model <model>", "Model name")
    .option("--timeout-ms <number>", "Request timeout in milliseconds", parsePositiveIntegerOption("--timeout-ms"))
    .option("--stream-idle-timeout-ms <number>", "Streaming idle timeout in milliseconds", parsePositiveIntegerOption("--stream-idle-timeout-ms"))
    .option("--max-retries <number>", "Maximum provider retries", parseNonNegativeIntegerOption("--max-retries"))
    .option("--workspace", "Write this workspace config instead of user config")
    .action((provider: string, commandOptions: ProviderSetupCommandOptions) => {
      const result = setupProviderConfig(provider, {
        ...(commandOptions.apiKey !== undefined ? { apiKey: commandOptions.apiKey } : {}),
        ...(commandOptions.baseUrl !== undefined ? { baseUrl: commandOptions.baseUrl } : {}),
        ...(commandOptions.contextWindowTokens !== undefined
          ? { contextWindowTokens: commandOptions.contextWindowTokens }
          : {}),
        ...(commandOptions.maxRetries !== undefined ? { maxRetries: commandOptions.maxRetries } : {}),
        ...(commandOptions.model !== undefined ? { model: commandOptions.model } : {}),
        ...(commandOptions.streamIdleTimeoutMs !== undefined
          ? { streamIdleTimeoutMs: commandOptions.streamIdleTimeoutMs }
          : {}),
        ...(commandOptions.timeoutMs !== undefined ? { timeoutMs: commandOptions.timeoutMs } : {}),
        ...resolveProviderConfigTarget(commandOptions.workspace === true)
      });
      console.log(
        formatProviderConfigWrite("Configured", result, {
          apiKeyProvided: commandOptions.apiKey !== undefined && commandOptions.apiKey.length > 0,
          baseUrlProvided: commandOptions.baseUrl !== undefined && commandOptions.baseUrl.length > 0,
          ...(commandOptions.contextWindowTokens !== undefined
            ? { contextWindowTokens: commandOptions.contextWindowTokens }
            : {}),
          modelProvided:
            (commandOptions.model !== undefined && commandOptions.model.length > 0) ||
            provider.includes(":")
        })
      );
    });

  providerCommand
    .command("use")
    .description("Select a provider in reusable user config")
    .argument("<provider>", "Provider name; provider:model also sets the model")
    .option("--workspace", "Write this workspace config instead of user config")
    .action((provider: string, commandOptions: ProviderUseCommandOptions) => {
      const result = useProviderConfig(provider, resolveProviderConfigTarget(commandOptions.workspace === true));
      console.log(formatProviderConfigWrite("Selected", result));
    });

  providerCommand
    .command("promote")
    .description("Save the current effective provider as the user default")
    .action(() => {
      const handle = createApplication(process.cwd());
      try {
        const result = promoteProviderConfig(handle.service.currentProvider());
        console.log(formatProviderConfigWrite("Promoted", result));
      } finally {
        handle.close();
      }
    });

  providerCommand.command("test").action(async () => {
    const handle = createApplication(process.cwd());
    try {
      const report = await handle.service.testCurrentProvider();
      console.log(formatProviderHealth(report));
      if (!report.ok) {
        process.exitCode = 1;
      }
    } finally {
      handle.close();
    }
  });

  providerCommand.command("smoke").description("Run a synthetic post-tool provider turn").action(async () => {
    const handle = createApplication(process.cwd());
    try {
      const report = await handle.service.smokeCurrentProvider();
      console.log(formatProviderSmoke(report));
      if (!report.ok) {
        process.exitCode = 1;
      }
    } finally {
      handle.close();
    }
  });

  providerCommand
    .command("stats")
    .option("--by <groupBy>", "Group by: provider | session | task | mode", "provider")
    .action((commandOptions: { by: "provider" | "session" | "task" | "mode" }) => {
      const handle = createApplication(process.cwd());
      try {
        console.log(formatProviderStats(handle.service.providerStats(commandOptions.by)));
      } finally {
        handle.close();
      }
    });

  providerCommand
    .command("route")
    .requiredOption("--mode <mode>", "cheap_first | balanced | quality_first")
    .action((commandOptions: { mode: "cheap_first" | "balanced" | "quality_first" }) => {
      const handle = createApplication(process.cwd());
      try {
        handle.service.setRoutingMode(commandOptions.mode);
        console.log(`Routing mode updated: ${commandOptions.mode}`);
      } finally {
        handle.close();
      }
    });

  const providerAliasCommand = providerCommand.command("alias").description("Manage model aliases");

  providerAliasCommand
    .command("list")
    .option("--workspace", "Read workspace aliases only")
    .action((commandOptions: { workspace?: boolean }) => {
      const appConfig = resolveAppConfig(process.cwd());
      const aliases = resolveMergedModelAliases(appConfig.workspaceRoot);
      const entries = listModelAliasEntries(aliases);
      if (entries.length === 0) {
        console.log("No model aliases configured.");
        return;
      }
      for (const entry of entries) {
        console.log(`${entry.alias} -> ${entry.target}`);
      }
      if (commandOptions.workspace === true) {
        console.log(`Scope note: showing merged aliases for ${appConfig.workspaceRoot}`);
      }
    });

  providerAliasCommand
    .command("add")
    .description("Add a model alias")
    .argument("<alias>", "Alias name")
    .argument("<target>", "Provider:model target")
    .option("--workspace", "Write to workspace config instead of user config")
    .action((alias: string, target: string, commandOptions: { workspace?: boolean }) => {
      const result = addModelAliasConfig(alias, target, resolveProviderConfigTarget(commandOptions.workspace === true));
      console.log(`Added alias ${result.alias} -> ${result.target}\nConfig Path: ${result.configPath}`);
    });

  providerAliasCommand
    .command("remove")
    .description("Remove a model alias")
    .argument("<alias>", "Alias name")
    .option("--workspace", "Remove from workspace config instead of user config")
    .action((alias: string, commandOptions: { workspace?: boolean }) => {
      const result = removeModelAliasConfig(alias, resolveProviderConfigTarget(commandOptions.workspace === true));
      console.log(`Removed alias ${result.alias} -> ${result.target}\nConfig Path: ${result.configPath}`);
    });

  const providerCustomCommand = providerCommand.command("custom").description("Manage custom providers");

  providerCustomCommand
    .command("list")
    .action(() => {
      const configured = createApplication(process.cwd());
      try {
        for (const provider of configured.service.listConfiguredProviders()) {
          if (provider.providerConfig.builtinProviderName === null) {
            console.log(`${provider.name} (${provider.displayName}) -> ${provider.model ?? "(default)"}`);
          }
        }
      } finally {
        configured.close();
      }
    });

  providerCustomCommand
    .command("add")
    .description("Add or update a custom provider")
    .argument("<name>", "Custom provider name")
    .requiredOption("--transport <transport>", "openai-compatible | anthropic-compatible")
    .option("--api-key <key>", "API key")
    .option("--base-url <url>", "Provider base URL")
    .option("--model <model>", "Default model")
    .option("--display-name <name>", "Display name")
    .option("--workspace", "Write to workspace config instead of user config")
    .action(
      (
        name: string,
        commandOptions: {
          apiKey?: string;
          baseUrl?: string;
          displayName?: string;
          model?: string;
          transport: "anthropic-compatible" | "openai-compatible";
          workspace?: boolean;
        }
      ) => {
        const result = setupCustomProviderConfig(name, {
          transport: commandOptions.transport,
          ...(commandOptions.apiKey !== undefined ? { apiKey: commandOptions.apiKey } : {}),
          ...(commandOptions.baseUrl !== undefined ? { baseUrl: commandOptions.baseUrl } : {}),
          ...(commandOptions.model !== undefined ? { model: commandOptions.model } : {}),
          ...(commandOptions.displayName !== undefined ? { displayName: commandOptions.displayName } : {}),
          ...resolveProviderConfigTarget(commandOptions.workspace === true)
        });
        console.log(formatProviderConfigWrite("Configured custom", result));
      }
    );

  providerCustomCommand
    .command("remove")
    .description("Remove a custom provider")
    .argument("<name>", "Custom provider name")
    .option("--workspace", "Remove from workspace config instead of user config")
    .action((name: string, commandOptions: { workspace?: boolean }) => {
      const result = removeCustomProviderConfig(name, resolveProviderConfigTarget(commandOptions.workspace === true));
      console.log(formatProviderConfigWrite("Removed custom", result));
    });

  const providerCredentialCommand = providerCommand
    .command("credential")
    .description("Manage provider credential pool");

  providerCredentialCommand
    .command("list")
    .argument("<provider>", "Provider name")
    .option("--workspace", "Read workspace config instead of user config")
    .action((provider: string, commandOptions: { workspace?: boolean }) => {
      const result = listProviderCredentialConfig(
        provider,
        resolveProviderConfigTarget(commandOptions.workspace === true)
      );
      if (result.credentials.length === 0) {
        console.log(`No credentials configured for ${result.providerName}.`);
      } else {
        for (const credential of result.credentials) {
          const disabled = credential.disabled ? "disabled" : "enabled";
          console.log(
            `${credential.id}: ${disabled}, env=${credential.apiKeyEnv ?? "-"}, priority=${credential.priority}`
          );
        }
      }
      console.log(`Config Path: ${result.configPath}`);
    });

  providerCredentialCommand
    .command("add-env")
    .argument("<provider>", "Provider name")
    .argument("<env>", "Environment variable containing the API key")
    .option("--id <id>", "Credential id")
    .option("--priority <number>", "Lower numbers are tried first", (value) => Number(value))
    .option("--workspace", "Write to workspace config instead of user config")
    .action(
      (
        provider: string,
        envName: string,
        commandOptions: { id?: string; priority?: number; workspace?: boolean }
      ) => {
        const result = addProviderCredentialEnvConfig(provider, {
          envName,
          ...(commandOptions.id !== undefined ? { id: commandOptions.id } : {}),
          ...(commandOptions.priority !== undefined ? { priority: commandOptions.priority } : {}),
          ...resolveProviderConfigTarget(commandOptions.workspace === true)
        });
        console.log(`Credential added for ${result.providerName}.\nConfig Path: ${result.configPath}`);
      }
    );

  providerCredentialCommand
    .command("disable")
    .argument("<provider>", "Provider name")
    .argument("<id>", "Credential id")
    .option("--workspace", "Write to workspace config instead of user config")
    .action((provider: string, id: string, commandOptions: { workspace?: boolean }) => {
      const result = setProviderCredentialEnabledConfig(
        provider,
        id,
        false,
        resolveProviderConfigTarget(commandOptions.workspace === true)
      );
      console.log(`Credential ${id} disabled for ${result.providerName}.\nConfig Path: ${result.configPath}`);
    });

  providerCredentialCommand
    .command("enable")
    .argument("<provider>", "Provider name")
    .argument("<id>", "Credential id")
    .option("--workspace", "Write to workspace config instead of user config")
    .action((provider: string, id: string, commandOptions: { workspace?: boolean }) => {
      const result = setProviderCredentialEnabledConfig(
        provider,
        id,
        true,
        resolveProviderConfigTarget(commandOptions.workspace === true)
      );
      console.log(`Credential ${id} enabled for ${result.providerName}.\nConfig Path: ${result.configPath}`);
    });

  providerCredentialCommand
    .command("remove")
    .argument("<provider>", "Provider name")
    .argument("<id>", "Credential id")
    .option("--workspace", "Write to workspace config instead of user config")
    .action((provider: string, id: string, commandOptions: { workspace?: boolean }) => {
      const result = removeProviderCredentialConfig(
        provider,
        id,
        resolveProviderConfigTarget(commandOptions.workspace === true)
      );
      console.log(`Credential ${id} removed for ${result.providerName}.\nConfig Path: ${result.configPath}`);
    });

  const providerFallbackCommand = providerCommand
    .command("fallback")
    .description("Manage provider fallback chain");

  providerFallbackCommand
    .command("list")
    .option("--slot <slot>", "Show fallback chain for an auxiliary slot")
    .action((commandOptions: { slot?: string }) => {
      const appConfig = resolveAppConfig(process.cwd());
      const fallbackProviders = commandOptions.slot === undefined
        ? resolveMergedFallbackProviders(appConfig.workspaceRoot)
        : resolveMergedFallbackProvidersForSlot(appConfig.workspaceRoot, commandOptions.slot);
      if (fallbackProviders.length === 0) {
        console.log("No fallback providers configured.");
        return;
      }
      for (const [index, selection] of fallbackProviders.entries()) {
        console.log(`${index + 1}. ${selection}`);
      }
    });

  providerFallbackCommand
    .command("add")
    .description("Append a fallback provider selection")
    .argument("<selection>", "Provider:model selection")
    .option("--workspace", "Write to workspace config instead of user config")
    .option("--slot <slot>", "Write fallback chain for an auxiliary slot")
    .action((selection: string, commandOptions: { slot?: string; workspace?: boolean }) => {
      const result = addFallbackProviderConfig(selection, {
        ...resolveProviderConfigTarget(commandOptions.workspace === true),
        ...(commandOptions.slot !== undefined ? { slot: commandOptions.slot } : {})
      });
      console.log(`Fallback providers:\n${result.fallbackProviders.map((entry, index) => `${index + 1}. ${entry}`).join("\n")}`);
      console.log(`Config Path: ${result.configPath}`);
    });

  providerFallbackCommand
    .command("remove")
    .description("Remove a fallback provider selection")
    .argument("<selection>", "Provider:model selection")
    .option("--workspace", "Write to workspace config instead of user config")
    .option("--slot <slot>", "Remove fallback from an auxiliary slot")
    .action((selection: string, commandOptions: { slot?: string; workspace?: boolean }) => {
      const result = removeFallbackProviderConfig(selection, {
        ...resolveProviderConfigTarget(commandOptions.workspace === true),
        ...(commandOptions.slot !== undefined ? { slot: commandOptions.slot } : {})
      });
      console.log(`Fallback providers:\n${result.fallbackProviders.map((entry, index) => `${index + 1}. ${entry}`).join("\n")}`);
      console.log(`Config Path: ${result.configPath}`);
    });

  providerFallbackCommand
    .command("clear")
    .description("Clear fallback provider chain")
    .option("--workspace", "Clear workspace config instead of user config")
    .option("--slot <slot>", "Clear fallback chain for an auxiliary slot")
    .action((commandOptions: { slot?: string; workspace?: boolean }) => {
      const result = clearFallbackProviderConfig({
        ...resolveProviderConfigTarget(commandOptions.workspace === true),
        ...(commandOptions.slot !== undefined ? { slot: commandOptions.slot } : {})
      });
      console.log(`Cleared fallback providers.\nConfig Path: ${result.configPath}`);
    });
}

function resolveProviderConfigTarget(workspace: boolean): { cwd?: string; scope: ProviderConfigScope } {
  if (!workspace) {
    return {
      scope: "user"
    };
  }

  return {
    cwd: resolveAppConfig(process.cwd()).workspaceRoot,
    scope: "workspace"
  };
}

function formatProviderConfigWrite(
  action: string,
  result: ProviderConfigWriteResult,
  setupHints?: {
    apiKeyProvided: boolean;
    baseUrlProvided: boolean;
    contextWindowTokens?: number;
    modelProvided: boolean;
  }
): string {
  const lines = [
    `${action} ${result.scope} provider: ${result.providerName}`,
    `Model: ${result.model ?? "-"}`,
    `Config Path: ${result.configPath}`
  ];
  if (setupHints !== undefined) {
    lines.push(
      ...formatProviderSetupNextSteps({
        ...setupHints,
        providerName: result.providerName
      })
    );
  } else {
    lines.push("Check: talon provider status", "Test: talon provider test");
  }
  return lines.join("\n");
}
