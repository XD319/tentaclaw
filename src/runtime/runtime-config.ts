import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { z } from "zod";

import type { TokenBudget } from "../types";

const tokenBudgetConfigSchema = z.object({
  inputLimit: z.number().int().positive().optional(),
  outputLimit: z.number().int().positive().optional(),
  reservedOutput: z.number().int().nonnegative().optional()
});

const runtimeConfigFileSchema = z.object({
  allowedFetchHosts: z.array(z.string().min(1)).optional(),
  defaultMaxIterations: z.number().int().positive().optional(),
  defaultTimeoutMs: z.number().int().positive().optional(),
  compact: z
    .object({
      messageThreshold: z.number().int().positive().optional(),
      summarizer: z.enum(["deterministic", "provider_subagent"]).optional(),
      tokenThreshold: z.number().int().positive().optional(),
      toolCallThreshold: z.number().int().positive().optional()
    })
    .optional(),
  tokenBudget: tokenBudgetConfigSchema.optional(),
  workflow: z
    .object({
      failureGuidedRetry: z
        .object({
          enabled: z.boolean().optional(),
          maxRepairAttempts: z.number().int().nonnegative().optional()
        })
        .optional(),
      repoMap: z
        .object({
          enabled: z.boolean().optional()
        })
        .optional(),
      testCommands: z.array(z.string().min(1)).optional()
    })
    .optional()
});

export interface WorkflowRuntimeConfig {
  failureGuidedRetry: {
    enabled: boolean;
    maxRepairAttempts: number;
  };
  repoMap: {
    enabled: boolean;
  };
  testCommands: string[];
}

export interface RuntimeConfig {
  allowedFetchHosts: string[];
  configPath: string;
  configSource: "defaults" | "env" | "file";
  defaultMaxIterations: number;
  defaultTimeoutMs: number;
  compact: {
    messageThreshold: number;
    tokenThreshold: number;
    toolCallThreshold: number;
    summarizer: "deterministic" | "provider_subagent";
  };
  tokenBudget: TokenBudget;
  workflow: WorkflowRuntimeConfig;
}

const DEFAULT_RUNTIME_CONFIG: Omit<RuntimeConfig, "configPath" | "configSource"> = {
  allowedFetchHosts: ["*"],
  defaultMaxIterations: 12,
  defaultTimeoutMs: 120_000,
  compact: {
    messageThreshold: 8,
    summarizer: "deterministic",
    tokenThreshold: 48_000,
    toolCallThreshold: 20
  },
  tokenBudget: {
    inputLimit: 64_000,
    outputLimit: 8_000,
    reservedOutput: 1_000,
    usedInput: 0,
    usedOutput: 0
  },
  workflow: {
    failureGuidedRetry: {
      enabled: true,
      maxRepairAttempts: 2
    },
    repoMap: {
      enabled: true
    },
    testCommands: ["npm test", "npm run build"]
  }
};

export function resolveRuntimeConfig(cwd = process.cwd()): RuntimeConfig {
  const workspaceRoot = resolve(cwd);
  const configPath = join(workspaceRoot, ".auto-talon", "runtime.config.json");
  const fileConfig = loadRuntimeConfigFile(configPath);
  const envConfig = readEnvRuntimeConfig();
  const configSource = Object.keys(envConfig).length > 0
    ? "env"
    : fileConfig === null
      ? "defaults"
      : "file";

  const tokenBudget: TokenBudget = {
    inputLimit:
      envConfig.tokenBudget?.inputLimit ??
      fileConfig?.tokenBudget?.inputLimit ??
      DEFAULT_RUNTIME_CONFIG.tokenBudget.inputLimit,
    outputLimit:
      envConfig.tokenBudget?.outputLimit ??
      fileConfig?.tokenBudget?.outputLimit ??
      DEFAULT_RUNTIME_CONFIG.tokenBudget.outputLimit,
    reservedOutput:
      envConfig.tokenBudget?.reservedOutput ??
      fileConfig?.tokenBudget?.reservedOutput ??
      DEFAULT_RUNTIME_CONFIG.tokenBudget.reservedOutput,
    usedInput: 0,
    usedOutput: 0
  };
  const workflow: WorkflowRuntimeConfig = {
    failureGuidedRetry: {
      enabled:
        envConfig.workflow?.failureGuidedRetry?.enabled ??
        fileConfig?.workflow?.failureGuidedRetry?.enabled ??
        DEFAULT_RUNTIME_CONFIG.workflow.failureGuidedRetry.enabled,
      maxRepairAttempts:
        envConfig.workflow?.failureGuidedRetry?.maxRepairAttempts ??
        fileConfig?.workflow?.failureGuidedRetry?.maxRepairAttempts ??
        DEFAULT_RUNTIME_CONFIG.workflow.failureGuidedRetry.maxRepairAttempts
    },
    repoMap: {
      enabled:
        envConfig.workflow?.repoMap?.enabled ??
        fileConfig?.workflow?.repoMap?.enabled ??
        DEFAULT_RUNTIME_CONFIG.workflow.repoMap.enabled
    },
    testCommands:
      envConfig.workflow?.testCommands ??
      fileConfig?.workflow?.testCommands ??
      DEFAULT_RUNTIME_CONFIG.workflow.testCommands
  };
  const merged = {
    allowedFetchHosts:
      envConfig.allowedFetchHosts ??
      fileConfig?.allowedFetchHosts ??
      DEFAULT_RUNTIME_CONFIG.allowedFetchHosts,
    defaultMaxIterations:
      envConfig.defaultMaxIterations ??
      fileConfig?.defaultMaxIterations ??
      DEFAULT_RUNTIME_CONFIG.defaultMaxIterations,
    defaultTimeoutMs:
      envConfig.defaultTimeoutMs ??
      fileConfig?.defaultTimeoutMs ??
      DEFAULT_RUNTIME_CONFIG.defaultTimeoutMs,
    compact: {
      messageThreshold:
        envConfig.compact?.messageThreshold ??
        fileConfig?.compact?.messageThreshold ??
        DEFAULT_RUNTIME_CONFIG.compact.messageThreshold,
      summarizer:
        envConfig.compact?.summarizer ??
        fileConfig?.compact?.summarizer ??
        DEFAULT_RUNTIME_CONFIG.compact.summarizer,
      tokenThreshold:
        envConfig.compact?.tokenThreshold ??
        fileConfig?.compact?.tokenThreshold ??
        DEFAULT_RUNTIME_CONFIG.compact.tokenThreshold,
      toolCallThreshold:
        envConfig.compact?.toolCallThreshold ??
        fileConfig?.compact?.toolCallThreshold ??
        DEFAULT_RUNTIME_CONFIG.compact.toolCallThreshold
    },
    tokenBudget,
    workflow
  };

  if (merged.tokenBudget.reservedOutput >= merged.tokenBudget.outputLimit) {
    throw new Error("runtime tokenBudget.reservedOutput must be lower than outputLimit.");
  }

  return {
    ...merged,
    allowedFetchHosts: normalizeHostList(merged.allowedFetchHosts),
    configPath,
    configSource,
    workflow: {
      ...merged.workflow,
      testCommands: merged.workflow.testCommands.map((command) => command.trim()).filter(Boolean)
    }
  };
}

type RuntimeConfigFile = z.infer<typeof runtimeConfigFileSchema>;

function loadRuntimeConfigFile(configPath: string): RuntimeConfigFile | null {
  if (!existsSync(configPath)) {
    return null;
  }

  const content = readFileSync(configPath, "utf8").trim();
  if (content.length === 0) {
    return {};
  }

  return runtimeConfigFileSchema.parse(JSON.parse(content));
}

function readEnvRuntimeConfig(): Partial<RuntimeConfigFile> {
  const config: Partial<RuntimeConfigFile> = {};
  const allowedFetchHosts = splitList(process.env.AGENT_ALLOWED_FETCH_HOSTS);
  if (allowedFetchHosts.length > 0) {
    config.allowedFetchHosts = allowedFetchHosts;
  }

  const defaultMaxIterations = readPositiveIntegerEnv("AGENT_DEFAULT_MAX_ITERATIONS");
  if (defaultMaxIterations !== undefined) {
    config.defaultMaxIterations = defaultMaxIterations;
  }

  const defaultTimeoutMs = readPositiveIntegerEnv("AGENT_DEFAULT_TIMEOUT_MS");
  if (defaultTimeoutMs !== undefined) {
    config.defaultTimeoutMs = defaultTimeoutMs;
  }

  const tokenBudget: RuntimeConfigFile["tokenBudget"] = {};
  const inputLimit = readPositiveIntegerEnv("AGENT_TOKEN_INPUT_LIMIT");
  if (inputLimit !== undefined) {
    tokenBudget.inputLimit = inputLimit;
  }
  const outputLimit = readPositiveIntegerEnv("AGENT_TOKEN_OUTPUT_LIMIT");
  if (outputLimit !== undefined) {
    tokenBudget.outputLimit = outputLimit;
  }
  const reservedOutput = readNonNegativeIntegerEnv("AGENT_TOKEN_RESERVED_OUTPUT");
  if (reservedOutput !== undefined) {
    tokenBudget.reservedOutput = reservedOutput;
  }
  if (Object.keys(tokenBudget).length > 0) {
    config.tokenBudget = tokenBudget;
  }

  const testCommands = splitList(process.env.AGENT_WORKFLOW_TEST_COMMANDS);
  if (testCommands.length > 0) {
    config.workflow = {
      ...(config.workflow ?? {}),
      testCommands
    };
  }

  const maxRepairAttempts = readNonNegativeIntegerEnv("AGENT_FAILURE_REPAIR_ATTEMPTS");
  if (maxRepairAttempts !== undefined) {
    config.workflow = {
      ...(config.workflow ?? {}),
      failureGuidedRetry: {
        ...(config.workflow?.failureGuidedRetry ?? {}),
        maxRepairAttempts
      }
    };
  }

  return runtimeConfigFileSchema.partial().parse(config);
}

function splitList(value: string | undefined): string[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readPositiveIntegerEnv(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function readNonNegativeIntegerEnv(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function normalizeHostList(hosts: string[]): string[] {
  const normalized = hosts.map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (normalized.length === 0) {
    throw new Error("runtime allowedFetchHosts must contain at least one host or '*'.");
  }
  return [...new Set(normalized)];
}
