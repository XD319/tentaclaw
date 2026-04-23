import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { z } from "zod";

import type { BudgetLimits, BudgetPricingEntry, ProviderTier, RoutingMode, TokenBudget } from "../types/index.js";

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
  recall: z
    .object({
      budgetRatio: z.number().positive().max(1).optional(),
      enabled: z.boolean().optional(),
      maxCandidatesPerScope: z.number().int().positive().optional()
    })
    .optional(),
  promotion: z
    .object({
      enabled: z.boolean().optional(),
      maxHumanJudgmentWeight: z.number().min(0).max(1).optional(),
      minStability: z.number().min(0).max(1).optional(),
      minSuccessCount: z.number().int().nonnegative().optional(),
      minSuccessRate: z.number().min(0).max(1).optional(),
      riskDenyKeywords: z.array(z.string().min(1)).optional()
    })
    .optional(),
  routing: z
    .object({
      helpers: z
        .object({
          classify: z.enum(["cheap", "balanced", "quality"]).nullable().optional(),
          recallRank: z.enum(["cheap", "balanced", "quality"]).nullable().optional(),
          summarize: z.enum(["cheap", "balanced", "quality"]).nullable().optional()
        })
        .optional(),
      mode: z.enum(["cheap_first", "balanced", "quality_first"]).optional(),
      providers: z
        .object({
          balanced: z.string().min(1).optional(),
          cheap: z.string().min(1).optional(),
          quality: z.string().min(1).optional()
        })
        .optional()
    })
    .optional(),
  budget: z
    .object({
      pricing: z
        .record(
          z.string().min(1),
          z.object({
            cachedInputPerMillion: z.number().nonnegative().optional(),
            inputPerMillion: z.number().nonnegative(),
            outputPerMillion: z.number().nonnegative()
          })
        )
        .optional(),
      task: z
        .object({
          hardCostUsd: z.number().nonnegative().optional(),
          hardInputTokens: z.number().int().nonnegative().optional(),
          hardOutputTokens: z.number().int().nonnegative().optional(),
          softCostUsd: z.number().nonnegative().optional(),
          softInputTokens: z.number().int().nonnegative().optional(),
          softOutputTokens: z.number().int().nonnegative().optional()
        })
        .optional(),
      thread: z
        .object({
          hardCostUsd: z.number().nonnegative().optional(),
          hardInputTokens: z.number().int().nonnegative().optional(),
          hardOutputTokens: z.number().int().nonnegative().optional(),
          softCostUsd: z.number().nonnegative().optional(),
          softInputTokens: z.number().int().nonnegative().optional(),
          softOutputTokens: z.number().int().nonnegative().optional()
        })
        .optional()
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
  recall: {
    enabled: boolean;
    budgetRatio: number;
    maxCandidatesPerScope: number;
  };
  promotion: {
    enabled: boolean;
    minSuccessCount: number;
    minSuccessRate: number;
    minStability: number;
    maxHumanJudgmentWeight: number;
    riskDenyKeywords: string[];
  };
  routing: {
    mode: RoutingMode;
    providers: {
      cheap?: string;
      balanced?: string;
      quality?: string;
    };
    helpers: {
      summarize: ProviderTier | null;
      classify: ProviderTier | null;
      recallRank: ProviderTier | null;
    };
  };
  budget: {
    task: BudgetLimits;
    thread: BudgetLimits;
    pricing: Record<string, BudgetPricingEntry>;
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
  recall: {
    budgetRatio: 0.25,
    enabled: true,
    maxCandidatesPerScope: 10
  },
  promotion: {
    enabled: true,
    maxHumanJudgmentWeight: 0.4,
    minStability: 0.6,
    minSuccessCount: 3,
    minSuccessRate: 0.8,
    riskDenyKeywords: ["rm", "delete", "password", "secret", "drop table", "approval_required"]
  },
  tokenBudget: {
    inputLimit: 64_000,
    outputLimit: 8_000,
    reservedOutput: 1_000,
    usedInput: 0,
    usedOutput: 0,
    usedCostUsd: 0
  },
  routing: {
    mode: "balanced",
    providers: {},
    helpers: {
      summarize: "cheap",
      classify: null,
      recallRank: null
    }
  },
  budget: {
    task: {},
    thread: {},
    pricing: {}
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
    usedOutput: 0,
    usedCostUsd: 0
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
    recall: {
      budgetRatio:
        envConfig.recall?.budgetRatio ??
        fileConfig?.recall?.budgetRatio ??
        DEFAULT_RUNTIME_CONFIG.recall.budgetRatio,
      enabled:
        envConfig.recall?.enabled ??
        fileConfig?.recall?.enabled ??
        DEFAULT_RUNTIME_CONFIG.recall.enabled,
      maxCandidatesPerScope:
        envConfig.recall?.maxCandidatesPerScope ??
        fileConfig?.recall?.maxCandidatesPerScope ??
        DEFAULT_RUNTIME_CONFIG.recall.maxCandidatesPerScope
    },
    promotion: {
      enabled:
        envConfig.promotion?.enabled ??
        fileConfig?.promotion?.enabled ??
        DEFAULT_RUNTIME_CONFIG.promotion.enabled,
      maxHumanJudgmentWeight:
        envConfig.promotion?.maxHumanJudgmentWeight ??
        fileConfig?.promotion?.maxHumanJudgmentWeight ??
        DEFAULT_RUNTIME_CONFIG.promotion.maxHumanJudgmentWeight,
      minStability:
        envConfig.promotion?.minStability ??
        fileConfig?.promotion?.minStability ??
        DEFAULT_RUNTIME_CONFIG.promotion.minStability,
      minSuccessCount:
        envConfig.promotion?.minSuccessCount ??
        fileConfig?.promotion?.minSuccessCount ??
        DEFAULT_RUNTIME_CONFIG.promotion.minSuccessCount,
      minSuccessRate:
        envConfig.promotion?.minSuccessRate ??
        fileConfig?.promotion?.minSuccessRate ??
        DEFAULT_RUNTIME_CONFIG.promotion.minSuccessRate,
      riskDenyKeywords:
        envConfig.promotion?.riskDenyKeywords ??
        fileConfig?.promotion?.riskDenyKeywords ??
        DEFAULT_RUNTIME_CONFIG.promotion.riskDenyKeywords
    },
    routing: {
      mode:
        envConfig.routing?.mode ??
        fileConfig?.routing?.mode ??
        DEFAULT_RUNTIME_CONFIG.routing.mode,
      providers: normalizeRoutingProviders(
        envConfig.routing?.providers ??
          fileConfig?.routing?.providers ??
          DEFAULT_RUNTIME_CONFIG.routing.providers
      ),
      helpers: {
        summarize:
          envConfig.routing?.helpers?.summarize ??
          fileConfig?.routing?.helpers?.summarize ??
          DEFAULT_RUNTIME_CONFIG.routing.helpers.summarize,
        classify:
          envConfig.routing?.helpers?.classify ??
          fileConfig?.routing?.helpers?.classify ??
          DEFAULT_RUNTIME_CONFIG.routing.helpers.classify,
        recallRank:
          envConfig.routing?.helpers?.recallRank ??
          fileConfig?.routing?.helpers?.recallRank ??
          DEFAULT_RUNTIME_CONFIG.routing.helpers.recallRank
      }
    },
    budget: {
      task: normalizeBudgetLimits(
        envConfig.budget?.task ?? fileConfig?.budget?.task ?? DEFAULT_RUNTIME_CONFIG.budget.task
      ),
      thread: normalizeBudgetLimits(
        envConfig.budget?.thread ?? fileConfig?.budget?.thread ?? DEFAULT_RUNTIME_CONFIG.budget.thread
      ),
      pricing:
        normalizeBudgetPricing(
          envConfig.budget?.pricing ??
            fileConfig?.budget?.pricing ??
            DEFAULT_RUNTIME_CONFIG.budget.pricing
        )
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

  const promotionEnabled = readBooleanEnv("AGENT_PROMOTION_ENABLED");
  if (promotionEnabled !== undefined) {
    config.promotion = {
      ...(config.promotion ?? {}),
      enabled: promotionEnabled
    };
  }

  const minSuccessCount = readNonNegativeIntegerEnv("AGENT_PROMOTION_MIN_SUCCESS_COUNT");
  if (minSuccessCount !== undefined) {
    config.promotion = {
      ...(config.promotion ?? {}),
      minSuccessCount
    };
  }

  const minSuccessRate = readBoundedNumberEnv("AGENT_PROMOTION_MIN_SUCCESS_RATE", 0, 1);
  if (minSuccessRate !== undefined) {
    config.promotion = {
      ...(config.promotion ?? {}),
      minSuccessRate
    };
  }

  const minStability = readBoundedNumberEnv("AGENT_PROMOTION_MIN_STABILITY", 0, 1);
  if (minStability !== undefined) {
    config.promotion = {
      ...(config.promotion ?? {}),
      minStability
    };
  }

  const maxHumanJudgmentWeight = readBoundedNumberEnv("AGENT_PROMOTION_MAX_HUMAN_JUDGMENT_WEIGHT", 0, 1);
  if (maxHumanJudgmentWeight !== undefined) {
    config.promotion = {
      ...(config.promotion ?? {}),
      maxHumanJudgmentWeight
    };
  }

  const riskDenyKeywords = splitList(process.env.AGENT_PROMOTION_RISK_DENY_KEYWORDS);
  if (riskDenyKeywords.length > 0) {
    config.promotion = {
      ...(config.promotion ?? {}),
      riskDenyKeywords
    };
  }

  const routingMode = process.env.AGENT_ROUTING_MODE;
  if (routingMode === "cheap_first" || routingMode === "balanced" || routingMode === "quality_first") {
    config.routing = {
      ...(config.routing ?? {}),
      mode: routingMode
    };
  }

  const routeCheap = process.env.AGENT_ROUTE_PROVIDER_CHEAP?.trim();
  const routeBalanced = process.env.AGENT_ROUTE_PROVIDER_BALANCED?.trim();
  const routeQuality = process.env.AGENT_ROUTE_PROVIDER_QUALITY?.trim();
  if (routeCheap !== undefined || routeBalanced !== undefined || routeQuality !== undefined) {
    config.routing = {
      ...(config.routing ?? {}),
      providers: {
        ...(config.routing?.providers ?? {}),
        ...(routeCheap ? { cheap: routeCheap } : {}),
        ...(routeBalanced ? { balanced: routeBalanced } : {}),
        ...(routeQuality ? { quality: routeQuality } : {})
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

function readBooleanEnv(name: string): boolean | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw new Error(`${name} must be a boolean.`);
}

function readBoundedNumberEnv(name: string, min: number, max: number): number | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
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

function normalizeRoutingProviders(
  providers: { cheap?: string | undefined; balanced?: string | undefined; quality?: string | undefined }
): RuntimeConfig["routing"]["providers"] {
  return {
    ...(providers.cheap !== undefined ? { cheap: providers.cheap } : {}),
    ...(providers.balanced !== undefined ? { balanced: providers.balanced } : {}),
    ...(providers.quality !== undefined ? { quality: providers.quality } : {})
  };
}

function normalizeBudgetLimits(limits: BudgetLimits): BudgetLimits {
  return {
    ...(limits.softInputTokens !== undefined ? { softInputTokens: limits.softInputTokens } : {}),
    ...(limits.hardInputTokens !== undefined ? { hardInputTokens: limits.hardInputTokens } : {}),
    ...(limits.softOutputTokens !== undefined ? { softOutputTokens: limits.softOutputTokens } : {}),
    ...(limits.hardOutputTokens !== undefined ? { hardOutputTokens: limits.hardOutputTokens } : {}),
    ...(limits.softCostUsd !== undefined ? { softCostUsd: limits.softCostUsd } : {}),
    ...(limits.hardCostUsd !== undefined ? { hardCostUsd: limits.hardCostUsd } : {})
  };
}

function normalizeBudgetPricing(
  pricing: Record<
    string,
    { inputPerMillion: number; outputPerMillion: number; cachedInputPerMillion?: number | undefined }
  >
): Record<string, BudgetPricingEntry> {
  const normalized: Record<string, BudgetPricingEntry> = {};
  for (const [providerName, entry] of Object.entries(pricing)) {
    normalized[providerName] = {
      inputPerMillion: entry.inputPerMillion,
      outputPerMillion: entry.outputPerMillion,
      ...(entry.cachedInputPerMillion !== undefined
        ? { cachedInputPerMillion: entry.cachedInputPerMillion }
        : {})
    };
  }
  return normalized;
}
