import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import type { DiffDisplayMode } from "../presentation/diff-display.js";
import { DEFAULT_DIFF_DISPLAY_MODE } from "../presentation/diff-display.js";
import {
  DEFAULT_TUI_STATUS_LINE_CONFIG,
  resolveTuiStatusLineConfig,
  statusLineConfigSchema,
  type TuiStatusLineConfig
} from "./tui-status-line-config.js";
import type {
  WebBackend,
  WebExtractBackend,
  WebProviderRuntimeConfig,
  WebRuntimeConfig,
  WebSearchBackend,
  WebSearchRuntimeConfig
} from "../core/web-search-config.js";
import type { ContextRetentionConfig } from "./context/recent-file-reads.js";
import { resolveWorkspaceLayout } from "./workspace-layout.js";
import {
  AUXILIARY_SLOTS,
  DEFAULT_AUXILIARY_CONFIG,
  normalizeAuxiliaryConfig,
  type AuxiliaryRuntimeConfig
} from "../providers/auxiliary-resolver.js";
import type { AuxiliarySlot } from "../providers/auxiliary-resolver.js";
import {
  resolveProviderConfigForProvider,
  resolveProviderSelectionWithAliases
} from "../providers/config.js";
import { isProviderSwitchable } from "../providers/provider-switchable.js";
import type { BudgetLimits, BudgetPricingEntry, ProviderTier, RoutingMode, TokenBudget } from "../types/index.js";

export type { WebRuntimeConfig, WebSearchRuntimeConfig } from "../core/web-search-config.js";

const webBackendSchema = z.enum([
  "auto",
  "brave",
  "ddgs",
  "disabled",
  "exa",
  "firecrawl",
  "http",
  "searxng",
  "tavily"
]);

const webSearchBackendSchema = webBackendSchema.exclude(["http"]);
const webExtractBackendSchema = webBackendSchema.exclude(["brave", "ddgs", "searxng"]);

const tokenBudgetConfigSchema = z.object({
  inputLimit: z.number().int().positive().optional(),
  outputLimit: z.number().int().positive().optional(),
  reservedOutput: z.number().int().nonnegative().optional(),
  unknownContextWindowFallback: z.number().int().positive().optional()
});

const contextConfigSchema = z.object({
  engine: z.enum(["hermes_compressor"]).optional()
});

const workflowTestCommandSchema = z.union([
  z.string().min(1),
  z.object({
    category: z.enum(["build", "lint", "test", "typecheck", "other"]).optional(),
    command: z.string().min(1),
    name: z.string().min(1),
    timeoutMs: z.number().int().positive().optional()
  })
]);

const workflowLongRunningCommandSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  name: z.string().min(1)
});

const shellBackendSchema = z.enum(["default", "powershell", "cmd", "git-bash", "wsl", "docker-sh", "custom"]);

const diffDisplaySchema = z.enum(["summary", "collapsed", "full"]);
const interactionModeSchema = z.enum(["agent", "plan", "acceptEdits"]);
const agentWriteApprovalSchema = z.enum(["off", "on", "acceptEditsOnly"]);

const runtimeConfigFileSchema = z.object({
  allowedFetchHosts: z.array(z.string().min(1)).optional(),
  approvalTtlMs: z.number().int().positive().optional(),
  defaultInteractionMode: interactionModeSchema.optional(),
  interactionModes: z
    .object({
      agentWriteApproval: agentWriteApprovalSchema.optional()
    })
    .optional(),
  defaultMaxIterations: z.number().int().positive().optional(),
  defaultTimeoutMs: z.number().int().positive().optional(),
  webSearch: z
    .object({
      apiKeyEnv: z.string().min(1).optional(),
      apiUrl: z.string().url().optional(),
      backend: z.enum(["disabled", "firecrawl"]).optional(),
      maxResults: z.number().int().positive().max(50).optional()
    })
    .optional(),
  web: z
    .object({
      backend: webBackendSchema.optional(),
      searchBackend: webSearchBackendSchema.optional(),
      extractBackend: webExtractBackendSchema.optional(),
      maxResults: z.number().int().positive().max(50).optional(),
      longPageThresholdBytes: z.number().int().positive().optional(),
      summaryTargetBytes: z.number().int().positive().optional(),
      providers: z
        .object({
          brave: z.object({ apiKeyEnv: z.string().min(1).optional(), apiUrl: z.string().url().optional() }).optional(),
          ddgs: z.object({ apiKeyEnv: z.string().min(1).optional(), apiUrl: z.string().url().optional() }).optional(),
          exa: z.object({ apiKeyEnv: z.string().min(1).optional(), apiUrl: z.string().url().optional() }).optional(),
          firecrawl: z.object({ apiKeyEnv: z.string().min(1).optional(), apiUrl: z.string().url().optional() }).optional(),
          searxng: z.object({ apiKeyEnv: z.string().min(1).optional(), apiUrl: z.string().url().optional() }).optional(),
          tavily: z.object({ apiKeyEnv: z.string().min(1).optional(), apiUrl: z.string().url().optional() }).optional()
        })
        .optional()
    })
    .optional(),
  scheduler: z
    .object({
      pollIntervalMs: z.number().int().positive().optional()
    })
    .optional(),
  concurrency: z
    .object({
      allowParallelSessions: z.boolean().optional()
    })
    .optional(),
  compact: z
    .object({
      bufferTokens: z.number().int().nonnegative().optional(), // deprecated: kept for backward compatibility, no runtime effect
      hygieneThresholdRatio: z.number().positive().max(1).optional(),
      compactCooldownIterations: z.number().int().nonnegative().optional(),
      iterationThreshold: z.number().int().positive().optional(),
      messageThreshold: z.number().int().positive().optional(),
      minTokenPressureRatio: z.number().positive().max(1).optional(),
      protectFirstN: z.number().int().nonnegative().optional(),
      protectLastN: z.number().int().positive().optional(),
      resumeUserTailMessages: z.number().int().positive().optional(),
      summarizer: z.enum(["deterministic", "provider_subagent"]).optional(),
      targetRatio: z.number().positive().max(1).optional(),
      tailMinMessages: z.number().int().positive().optional(),
      tailTokenBudget: z.number().int().positive().optional(),
      thresholdRatio: z.number().positive().max(1).optional(),
      tokenThreshold: z.number().int().positive().optional(),
      toolCallThreshold: z.number().int().positive().optional()
    })
    .optional(),
  context: contextConfigSchema.optional(),
  contextRetention: z
    .object({
      maxBytesPerFile: z.number().int().positive().optional(),
      maxBytesPerFileUnderGuard: z.number().int().positive().optional(),
      maxFiles: z.number().int().positive().optional(),
      maxTotalBytes: z.number().int().positive().optional(),
      maxTotalBytesUnderGuard: z.number().int().positive().optional(),
      toolOutputMaxTokens: z.number().int().positive().optional(),
      toolResultKeepGroups: z.number().int().positive().optional()
    })
    .optional(),
  memory: z
    .object({
      enabled: z.boolean().optional(),
      core: z
        .object({
          profileTokenBudget: z.number().int().positive().optional(),
          projectTokenBudget: z.number().int().positive().optional()
        })
        .optional(),
      flush: z
        .object({
          enabled: z.boolean().optional(),
          maxSuggestions: z.number().int().positive().max(10).optional()
        })
        .optional(),
      search: z
        .object({
          provider: z.enum(["fts", "openai_compatible"]).optional(),
          openaiCompatible: z
            .object({
              endpoint: z.string().url().optional(),
              model: z.string().min(1).optional(),
              apiKeyEnv: z.string().min(1).optional(),
              dimensions: z.number().int().positive().optional(),
              timeoutMs: z.number().int().positive().optional(),
              batchSize: z.number().int().positive().optional()
            })
            .optional()
        })
        .optional()
    })
    .optional(),  recall: z
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
  skills: z
    .object({
      builtinRoot: z.string().min(1).optional(),
      precedence: z.array(z.enum(["builtin", "local", "project", "team"])).optional(),
      teamRoots: z.array(z.string().min(1)).optional()
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
  auxiliary: z
    .object({
      classify: z.string().optional(),
      compression: z.string().optional(),
      recallRank: z.string().optional(),
      summarize: z.string().optional(),
      title: z.string().optional(),
      vision: z.string().optional()
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
      session: z
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
      maxShellTimeoutMs: z.number().int().positive().optional(),
      shellBackend: shellBackendSchema.optional(),
      customShell: z
        .object({
          args: z.array(z.string()).optional(),
          executable: z.string().min(1)
        })
        .optional(),
      repoMap: z
        .object({
          enabled: z.boolean().optional()
        })
        .optional(),
      longRunningCommands: z.array(workflowLongRunningCommandSchema).optional(),
      testCommands: z.array(workflowTestCommandSchema).optional()
    })
    .optional(),
  tui: z
    .object({
      diffDisplay: diffDisplaySchema.optional(),
      statusLine: statusLineConfigSchema.optional()
    })
    .optional()
});

export type { TuiStatusLineConfig } from "./tui-status-line-config.js";

export interface WorkflowRuntimeConfig {
  failureGuidedRetry: {
    enabled: boolean;
    maxRepairAttempts: number;
  };
  maxShellTimeoutMs: number;
  shellBackend: ShellBackend;
  customShell: WorkflowCustomShell | null;
  repoMap: {
    enabled: boolean;
  };
  longRunningCommands: WorkflowLongRunningCommand[];
  testCommands: WorkflowTestCommand[];
}

export type ShellBackend = z.infer<typeof shellBackendSchema>;

export interface WorkflowCustomShell {
  args: string[];
  executable: string;
}

export type WorkflowTestCommand =
  | string
  | {
      category?: "build" | "lint" | "test" | "typecheck" | "other" | undefined;
      command: string;
      name: string;
      timeoutMs?: number | undefined;
    };

export interface WorkflowLongRunningCommand {
  command: string;
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  name: string;
}

export type { DiffDisplayMode } from "../presentation/diff-display.js";

export type AgentWriteApprovalMode = "off" | "on" | "acceptEditsOnly";

export interface InteractionModesRuntimeConfig {
  agentWriteApproval: AgentWriteApprovalMode;
}

export interface RuntimeConfig {
  allowedFetchHosts: string[];
  approvalTtlMs: number;
  configPath: string;
  configSource: "defaults" | "env" | "file";
  defaultInteractionMode: "agent" | "plan" | "acceptEdits";
  defaultMaxIterations: number;
  defaultTimeoutMs: number;
  interactionModes: InteractionModesRuntimeConfig;
  compact: {
    bufferTokens: number;
    compactCooldownIterations: number;
    hygieneThresholdRatio: number;
    iterationThreshold: number;
    messageThreshold: number;
    minTokenPressureRatio: number;
    protectFirstN: number;
    protectLastN: number;
    resumeUserTailMessages: number;
    summarizer: "deterministic" | "provider_subagent";
    targetRatio: number;
    tailMinMessages: number;
    tailTokenBudget: number | null;
    thresholdRatio: number;
    tokenThreshold: number | null;
    toolCallThreshold: number;
  };
  context: {
    engine: "hermes_compressor";
  };
  contextRetention: ContextRetentionConfig;
  memory: {
    enabled: boolean;
    core: {
      profileTokenBudget: number;
      projectTokenBudget: number;
    };
    flush: {
      enabled: boolean;
      maxSuggestions: number;
    };
    search: {
      provider: "fts" | "openai_compatible";
      openaiCompatible: {
        endpoint: string;
        model: string;
        apiKeyEnv: string;
        dimensions: number;
        timeoutMs: number;
        batchSize: number;
      };
    };
  };  recall: {
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
  skills: {
    builtinRoot: string | null;
    precedence: Array<"builtin" | "local" | "project" | "team">;
    teamRoots: string[];
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
  auxiliary: AuxiliaryRuntimeConfig;
  budget: {
    task: BudgetLimits;
    session: BudgetLimits;
    pricing: Record<string, BudgetPricingEntry>;
  };
  tokenBudget: TokenBudget;
  tokenBudgetInputLimitExplicit: boolean;
  unknownContextWindowFallback: number;
  tui: {
    diffDisplay: DiffDisplayMode;
    statusLine: TuiStatusLineConfig;
  };
  webSearch: WebSearchRuntimeConfig;
  web: WebRuntimeConfig;
  workflow: WorkflowRuntimeConfig;
  scheduler: {
    pollIntervalMs: number;
  };
  concurrency: {
    allowParallelSessions: boolean;
  };
}

const DEFAULT_RUNTIME_CONFIG: Omit<RuntimeConfig, "configPath" | "configSource"> = {
  allowedFetchHosts: ["*"],
  approvalTtlMs: 300_000,
  defaultInteractionMode: "agent",
  defaultMaxIterations: 12,
  defaultTimeoutMs: 120_000,
  interactionModes: {
    agentWriteApproval: "off"
  },
  scheduler: {
    pollIntervalMs: 2_000
  },
  concurrency: {
    allowParallelSessions: false
  },
  webSearch: {
    apiKey: null,
    apiKeyEnv: "FIRECRAWL_API_KEY",
    apiUrl: "https://api.firecrawl.dev/v1/search",
    backend: "disabled",
    maxResults: 5
  },
  web: {
    backend: "auto",
    searchBackend: "ddgs",
    extractBackend: "http",
    maxResults: 5,
    longPageThresholdBytes: 64_000,
    summaryTargetBytes: 5_000,
    providers: {
      brave: {
        apiKey: null,
        apiKeyEnv: "BRAVE_SEARCH_API_KEY",
        apiUrl: "https://api.search.brave.com/res/v1/web/search"
      },
      ddgs: {
        apiKey: null,
        apiKeyEnv: null,
        apiUrl: null
      },
      exa: {
        apiKey: null,
        apiKeyEnv: "EXA_API_KEY",
        apiUrl: "https://api.exa.ai/search"
      },
      firecrawl: {
        apiKey: null,
        apiKeyEnv: "FIRECRAWL_API_KEY",
        apiUrl: "https://api.firecrawl.dev/v1/search"
      },
      searxng: {
        apiKey: null,
        apiKeyEnv: null,
        apiUrl: null
      },
      tavily: {
        apiKey: null,
        apiKeyEnv: "TAVILY_API_KEY",
        apiUrl: "https://api.tavily.com/search"
      }
    }
  },
  compact: {
    bufferTokens: 0,
    compactCooldownIterations: 2,
    hygieneThresholdRatio: 0.85,
    iterationThreshold: 24,
    messageThreshold: 100,
    minTokenPressureRatio: 0.5,
    protectFirstN: 3,
    protectLastN: 20,
    resumeUserTailMessages: 6,
    summarizer: "provider_subagent",
    targetRatio: 0.2,
    tailMinMessages: 10,
    tailTokenBudget: null,
    thresholdRatio: 0.75,
    tokenThreshold: null,
    toolCallThreshold: 40
  },
  context: {
    engine: "hermes_compressor"
  },
  contextRetention: {
    maxBytesPerFile: 24_000,
    maxBytesPerFileUnderGuard: 24_000,
    maxFiles: 8,
    maxTotalBytes: 128_000,
    maxTotalBytesUnderGuard: 200_000,
    toolOutputMaxTokens: 2_500,
    toolResultKeepGroups: 5
  },
  memory: {
    enabled: false,
    core: {
      profileTokenBudget: 500,
      projectTokenBudget: 800
    },
    flush: {
      enabled: true,
      maxSuggestions: 3
    },
    search: {
      provider: "fts",
      openaiCompatible: {
        endpoint: "https://api.openai.com/v1/embeddings",
        model: "text-embedding-3-small",
        apiKeyEnv: "OPENAI_API_KEY",
        dimensions: 1536,
        timeoutMs: 10_000,
        batchSize: 32
      }
    }
  },  recall: {
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
  skills: {
    builtinRoot: null,
    precedence: ["builtin", "local", "project", "team"],
    teamRoots: []
  },
  tokenBudget: {
    inputLimit: 64_000,
    outputLimit: 8_000,
    reservedOutput: 1_000,
    usedInput: 0,
    usedOutput: 0,
    usedCostUsd: 0
  },
  tokenBudgetInputLimitExplicit: false,
  unknownContextWindowFallback: 32_000,
  routing: {
    mode: "balanced",
    providers: {},
    helpers: {
      summarize: "cheap",
      classify: null,
      recallRank: null
    }
  },
  auxiliary: DEFAULT_AUXILIARY_CONFIG,
  budget: {
    task: {},
    session: {},
    pricing: {}
  },
  tui: {
    diffDisplay: DEFAULT_DIFF_DISPLAY_MODE,
    statusLine: DEFAULT_TUI_STATUS_LINE_CONFIG
  },
  workflow: {
    failureGuidedRetry: {
      enabled: true,
      maxRepairAttempts: 2
    },
    maxShellTimeoutMs: 30_000,
    shellBackend: "default",
    customShell: null,
    repoMap: {
      enabled: true
    },
    longRunningCommands: [],
    testCommands: ["npm test", "npm run build"]
  }
};

export function resolveRuntimeConfig(cwd = process.cwd()): RuntimeConfig {
  const layout = resolveWorkspaceLayout(cwd);
  const userConfigPath = join(layout.userConfigRoot, "runtime.config.json");
  const workspaceConfigPath = layout.configRoot === null ? null : join(layout.configRoot, "runtime.config.json");
  const userConfig = loadRuntimeConfigFile(userConfigPath);
  const workspaceConfig = workspaceConfigPath === null ? null : loadRuntimeConfigFile(workspaceConfigPath);
  const fileConfig = mergeRuntimeConfigFiles(userConfig, workspaceConfig);
  const configPath = workspaceConfig !== null && workspaceConfigPath !== null ? workspaceConfigPath : userConfigPath;
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
  const tokenBudgetInputLimitExplicit =
    envConfig.tokenBudget?.inputLimit !== undefined || fileConfig?.tokenBudget?.inputLimit !== undefined;
  const unknownContextWindowFallback =
    envConfig.tokenBudget?.unknownContextWindowFallback ??
    fileConfig?.tokenBudget?.unknownContextWindowFallback ??
    DEFAULT_RUNTIME_CONFIG.unknownContextWindowFallback;
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
    maxShellTimeoutMs:
      envConfig.workflow?.maxShellTimeoutMs ??
      fileConfig?.workflow?.maxShellTimeoutMs ??
      DEFAULT_RUNTIME_CONFIG.workflow.maxShellTimeoutMs,
    shellBackend:
      envConfig.workflow?.shellBackend ??
      fileConfig?.workflow?.shellBackend ??
      DEFAULT_RUNTIME_CONFIG.workflow.shellBackend,
    customShell: normalizeWorkflowCustomShell(
      envConfig.workflow?.customShell ??
        fileConfig?.workflow?.customShell ??
        DEFAULT_RUNTIME_CONFIG.workflow.customShell
    ),
    repoMap: {
      enabled:
        envConfig.workflow?.repoMap?.enabled ??
        fileConfig?.workflow?.repoMap?.enabled ??
        DEFAULT_RUNTIME_CONFIG.workflow.repoMap.enabled
    },
    longRunningCommands:
      fileConfig?.workflow?.longRunningCommands ?? DEFAULT_RUNTIME_CONFIG.workflow.longRunningCommands,
    testCommands:
      envConfig.workflow?.testCommands ??
      fileConfig?.workflow?.testCommands ??
      DEFAULT_RUNTIME_CONFIG.workflow.testCommands
  };
  const webSearchApiKeyEnv =
    envConfig.webSearch?.apiKeyEnv ??
    fileConfig?.webSearch?.apiKeyEnv ??
    DEFAULT_RUNTIME_CONFIG.webSearch.apiKeyEnv;
  const webSearch: WebSearchRuntimeConfig = {
    apiKey: process.env[webSearchApiKeyEnv]?.trim() || null,
    apiKeyEnv: webSearchApiKeyEnv,
    apiUrl:
      envConfig.webSearch?.apiUrl ??
      fileConfig?.webSearch?.apiUrl ??
      DEFAULT_RUNTIME_CONFIG.webSearch.apiUrl,
    backend:
      envConfig.webSearch?.backend ??
      fileConfig?.webSearch?.backend ??
      DEFAULT_RUNTIME_CONFIG.webSearch.backend,
    maxResults:
      envConfig.webSearch?.maxResults ??
      fileConfig?.webSearch?.maxResults ??
      DEFAULT_RUNTIME_CONFIG.webSearch.maxResults
  };
  const web = resolveWebRuntimeConfig(fileConfig, envConfig, webSearch);
  const merged = {
    allowedFetchHosts:
      envConfig.allowedFetchHosts ??
      fileConfig?.allowedFetchHosts ??
      DEFAULT_RUNTIME_CONFIG.allowedFetchHosts,
    approvalTtlMs:
      envConfig.approvalTtlMs ??
      fileConfig?.approvalTtlMs ??
      DEFAULT_RUNTIME_CONFIG.approvalTtlMs,
    defaultInteractionMode:
      envConfig.defaultInteractionMode ??
      fileConfig?.defaultInteractionMode ??
      DEFAULT_RUNTIME_CONFIG.defaultInteractionMode,
    defaultMaxIterations:
      envConfig.defaultMaxIterations ??
      fileConfig?.defaultMaxIterations ??
      DEFAULT_RUNTIME_CONFIG.defaultMaxIterations,
    defaultTimeoutMs:
      envConfig.defaultTimeoutMs ??
      fileConfig?.defaultTimeoutMs ??
      DEFAULT_RUNTIME_CONFIG.defaultTimeoutMs,
    interactionModes: {
      agentWriteApproval:
        envConfig.interactionModes?.agentWriteApproval ??
        fileConfig?.interactionModes?.agentWriteApproval ??
        DEFAULT_RUNTIME_CONFIG.interactionModes.agentWriteApproval
    },
    compact: {
      bufferTokens:
        envConfig.compact?.bufferTokens ??
        fileConfig?.compact?.bufferTokens ??
        DEFAULT_RUNTIME_CONFIG.compact.bufferTokens,
      compactCooldownIterations:
        envConfig.compact?.compactCooldownIterations ??
        fileConfig?.compact?.compactCooldownIterations ??
        DEFAULT_RUNTIME_CONFIG.compact.compactCooldownIterations,
      hygieneThresholdRatio:
        envConfig.compact?.hygieneThresholdRatio ??
        fileConfig?.compact?.hygieneThresholdRatio ??
        DEFAULT_RUNTIME_CONFIG.compact.hygieneThresholdRatio,
      iterationThreshold:
        envConfig.compact?.iterationThreshold ??
        fileConfig?.compact?.iterationThreshold ??
        DEFAULT_RUNTIME_CONFIG.compact.iterationThreshold,
      messageThreshold:
        envConfig.compact?.messageThreshold ??
        fileConfig?.compact?.messageThreshold ??
        DEFAULT_RUNTIME_CONFIG.compact.messageThreshold,
      minTokenPressureRatio:
        envConfig.compact?.minTokenPressureRatio ??
        fileConfig?.compact?.minTokenPressureRatio ??
        DEFAULT_RUNTIME_CONFIG.compact.minTokenPressureRatio,
      protectFirstN:
        envConfig.compact?.protectFirstN ??
        fileConfig?.compact?.protectFirstN ??
        DEFAULT_RUNTIME_CONFIG.compact.protectFirstN,
      protectLastN:
        envConfig.compact?.protectLastN ??
        fileConfig?.compact?.protectLastN ??
        DEFAULT_RUNTIME_CONFIG.compact.protectLastN,
      resumeUserTailMessages:
        envConfig.compact?.resumeUserTailMessages ??
        fileConfig?.compact?.resumeUserTailMessages ??
        DEFAULT_RUNTIME_CONFIG.compact.resumeUserTailMessages,
      summarizer:
        envConfig.compact?.summarizer ??
        fileConfig?.compact?.summarizer ??
        DEFAULT_RUNTIME_CONFIG.compact.summarizer,
      targetRatio:
        envConfig.compact?.targetRatio ??
        fileConfig?.compact?.targetRatio ??
        DEFAULT_RUNTIME_CONFIG.compact.targetRatio,
      tailMinMessages:
        envConfig.compact?.tailMinMessages ??
        fileConfig?.compact?.tailMinMessages ??
        DEFAULT_RUNTIME_CONFIG.compact.tailMinMessages,
      tailTokenBudget:
        envConfig.compact?.tailTokenBudget ??
        fileConfig?.compact?.tailTokenBudget ??
        DEFAULT_RUNTIME_CONFIG.compact.tailTokenBudget,
      thresholdRatio:
        envConfig.compact?.thresholdRatio ??
        fileConfig?.compact?.thresholdRatio ??
        DEFAULT_RUNTIME_CONFIG.compact.thresholdRatio,
      tokenThreshold:
        envConfig.compact?.tokenThreshold ??
        fileConfig?.compact?.tokenThreshold ??
        DEFAULT_RUNTIME_CONFIG.compact.tokenThreshold,
      toolCallThreshold:
        envConfig.compact?.toolCallThreshold ??
        fileConfig?.compact?.toolCallThreshold ??
        DEFAULT_RUNTIME_CONFIG.compact.toolCallThreshold
    },
    context: {
      engine:
        envConfig.context?.engine ??
        fileConfig?.context?.engine ??
        DEFAULT_RUNTIME_CONFIG.context.engine
    },
    memory: {
      enabled:
        envConfig.memory?.enabled ??
        fileConfig?.memory?.enabled ??
        DEFAULT_RUNTIME_CONFIG.memory.enabled,
      core: {
        profileTokenBudget:
          envConfig.memory?.core?.profileTokenBudget ??
          fileConfig?.memory?.core?.profileTokenBudget ??
          DEFAULT_RUNTIME_CONFIG.memory.core.profileTokenBudget,
        projectTokenBudget:
          envConfig.memory?.core?.projectTokenBudget ??
          fileConfig?.memory?.core?.projectTokenBudget ??
          DEFAULT_RUNTIME_CONFIG.memory.core.projectTokenBudget
      },
      flush: {
        enabled:
          envConfig.memory?.flush?.enabled ??
          fileConfig?.memory?.flush?.enabled ??
          DEFAULT_RUNTIME_CONFIG.memory.flush.enabled,
        maxSuggestions:
          envConfig.memory?.flush?.maxSuggestions ??
          fileConfig?.memory?.flush?.maxSuggestions ??
          DEFAULT_RUNTIME_CONFIG.memory.flush.maxSuggestions
      },
      search: {
        provider:
          envConfig.memory?.search?.provider ??
          fileConfig?.memory?.search?.provider ??
          DEFAULT_RUNTIME_CONFIG.memory.search.provider,
        openaiCompatible: {
          endpoint: envConfig.memory?.search?.openaiCompatible?.endpoint ?? fileConfig?.memory?.search?.openaiCompatible?.endpoint ?? DEFAULT_RUNTIME_CONFIG.memory.search.openaiCompatible.endpoint,
          model: envConfig.memory?.search?.openaiCompatible?.model ?? fileConfig?.memory?.search?.openaiCompatible?.model ?? DEFAULT_RUNTIME_CONFIG.memory.search.openaiCompatible.model,
          apiKeyEnv: envConfig.memory?.search?.openaiCompatible?.apiKeyEnv ?? fileConfig?.memory?.search?.openaiCompatible?.apiKeyEnv ?? DEFAULT_RUNTIME_CONFIG.memory.search.openaiCompatible.apiKeyEnv,
          dimensions: envConfig.memory?.search?.openaiCompatible?.dimensions ?? fileConfig?.memory?.search?.openaiCompatible?.dimensions ?? DEFAULT_RUNTIME_CONFIG.memory.search.openaiCompatible.dimensions,
          timeoutMs: envConfig.memory?.search?.openaiCompatible?.timeoutMs ?? fileConfig?.memory?.search?.openaiCompatible?.timeoutMs ?? DEFAULT_RUNTIME_CONFIG.memory.search.openaiCompatible.timeoutMs,
          batchSize: envConfig.memory?.search?.openaiCompatible?.batchSize ?? fileConfig?.memory?.search?.openaiCompatible?.batchSize ?? DEFAULT_RUNTIME_CONFIG.memory.search.openaiCompatible.batchSize
        }
      }
    },    recall: {
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
    skills: {
      builtinRoot:
        envConfig.skills?.builtinRoot ??
        fileConfig?.skills?.builtinRoot ??
        DEFAULT_RUNTIME_CONFIG.skills.builtinRoot,
      precedence:
        envConfig.skills?.precedence ??
        fileConfig?.skills?.precedence ??
        DEFAULT_RUNTIME_CONFIG.skills.precedence,
      teamRoots:
        envConfig.skills?.teamRoots ??
        fileConfig?.skills?.teamRoots ??
        DEFAULT_RUNTIME_CONFIG.skills.teamRoots
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
    auxiliary: normalizeAuxiliaryConfig({
      ...DEFAULT_RUNTIME_CONFIG.auxiliary,
      ...fileConfig?.auxiliary,
      ...envConfig.auxiliary
    }),
    budget: {
      task: normalizeBudgetLimits(
        envConfig.budget?.task ?? fileConfig?.budget?.task ?? DEFAULT_RUNTIME_CONFIG.budget.task
      ),
      session: normalizeBudgetLimits(
        envConfig.budget?.session ?? fileConfig?.budget?.session ?? DEFAULT_RUNTIME_CONFIG.budget.session
      ),
      pricing:
        normalizeBudgetPricing(
          envConfig.budget?.pricing ??
            fileConfig?.budget?.pricing ??
            DEFAULT_RUNTIME_CONFIG.budget.pricing
        )
    },
    contextRetention: {
      maxFiles:
        envConfig.contextRetention?.maxFiles ??
        fileConfig?.contextRetention?.maxFiles ??
        DEFAULT_RUNTIME_CONFIG.contextRetention.maxFiles,
      maxBytesPerFile:
        envConfig.contextRetention?.maxBytesPerFile ??
        fileConfig?.contextRetention?.maxBytesPerFile ??
        DEFAULT_RUNTIME_CONFIG.contextRetention.maxBytesPerFile,
      maxTotalBytes:
        envConfig.contextRetention?.maxTotalBytes ??
        fileConfig?.contextRetention?.maxTotalBytes ??
        DEFAULT_RUNTIME_CONFIG.contextRetention.maxTotalBytes,
      maxBytesPerFileUnderGuard:
        envConfig.contextRetention?.maxBytesPerFileUnderGuard ??
        fileConfig?.contextRetention?.maxBytesPerFileUnderGuard ??
        DEFAULT_RUNTIME_CONFIG.contextRetention.maxBytesPerFileUnderGuard,
      maxTotalBytesUnderGuard:
        envConfig.contextRetention?.maxTotalBytesUnderGuard ??
        fileConfig?.contextRetention?.maxTotalBytesUnderGuard ??
        DEFAULT_RUNTIME_CONFIG.contextRetention.maxTotalBytesUnderGuard,
      toolOutputMaxTokens:
        envConfig.contextRetention?.toolOutputMaxTokens ??
        fileConfig?.contextRetention?.toolOutputMaxTokens ??
        DEFAULT_RUNTIME_CONFIG.contextRetention.toolOutputMaxTokens,
      toolResultKeepGroups:
        envConfig.contextRetention?.toolResultKeepGroups ??
        fileConfig?.contextRetention?.toolResultKeepGroups ??
        DEFAULT_RUNTIME_CONFIG.contextRetention.toolResultKeepGroups
    },
    tokenBudget,
    tokenBudgetInputLimitExplicit,
    unknownContextWindowFallback,
    tui: {
      diffDisplay:
        envConfig.tui?.diffDisplay ??
        fileConfig?.tui?.diffDisplay ??
        DEFAULT_RUNTIME_CONFIG.tui.diffDisplay,
      statusLine: resolveTuiStatusLineConfig(fileConfig?.tui?.statusLine, envConfig.tui?.statusLine)
    },
    scheduler: {
      pollIntervalMs:
        envConfig.scheduler?.pollIntervalMs ??
        fileConfig?.scheduler?.pollIntervalMs ??
        DEFAULT_RUNTIME_CONFIG.scheduler.pollIntervalMs
    },
    concurrency: {
      allowParallelSessions:
        envConfig.concurrency?.allowParallelSessions ??
        fileConfig?.concurrency?.allowParallelSessions ??
        DEFAULT_RUNTIME_CONFIG.concurrency.allowParallelSessions
    },
    webSearch,
    web,
    workflow
  };

  if (merged.tokenBudget.reservedOutput >= merged.tokenBudget.outputLimit) {
    throw new Error("runtime tokenBudget.reservedOutput must be lower than outputLimit.");
  }
  if (merged.tokenBudget.reservedOutput >= merged.tokenBudget.inputLimit) {
    throw new Error("runtime tokenBudget.reservedOutput must be lower than inputLimit.");
  }
  const normalizedCustomShell = normalizeWorkflowCustomShell(merged.workflow.customShell);
  if (merged.workflow.shellBackend === "custom" && normalizedCustomShell === null) {
    throw new Error("runtime workflow.customShell.executable is required when workflow.shellBackend is custom.");
  }
  const normalizedTestCommands = merged.workflow.testCommands
    .map(normalizeWorkflowTestCommand)
    .filter((command): command is WorkflowTestCommand => command !== null);
  const normalizedLongRunningCommands = merged.workflow.longRunningCommands
    .map(normalizeWorkflowLongRunningCommand)
    .filter((command): command is WorkflowLongRunningCommand => command !== null);

  return {
    ...merged,
    allowedFetchHosts: normalizeHostList(merged.allowedFetchHosts),
    configPath,
    configSource,
    workflow: {
      ...merged.workflow,
      customShell: normalizedCustomShell,
      testCommands:
        normalizedTestCommands.length > 0
          ? normalizedTestCommands
          : [...DEFAULT_RUNTIME_CONFIG.workflow.testCommands],
      longRunningCommands: normalizedLongRunningCommands
    }
  };
}

type RuntimeConfigFile = z.infer<typeof runtimeConfigFileSchema>;

function mergeRuntimeConfigFiles(userConfig: RuntimeConfigFile | null, workspaceConfig: RuntimeConfigFile | null): RuntimeConfigFile | null {
  if (userConfig === null && workspaceConfig === null) return null;
  const merged = deepMergeRuntime(userConfig ?? {}, workspaceConfig ?? {}) as RuntimeConfigFile;
  if (userConfig !== null && workspaceConfig !== null) {
    if (userConfig.web?.providers !== undefined) merged.web = { ...(merged.web ?? {}), providers: userConfig.web.providers };
    if (userConfig.web?.backend === "disabled") merged.web = { ...(merged.web ?? {}), backend: "disabled", searchBackend: "disabled", extractBackend: "disabled" };
    if (userConfig.web?.searchBackend === "disabled") merged.web = { ...(merged.web ?? {}), searchBackend: "disabled" };
    if (userConfig.webSearch?.backend === "disabled") merged.webSearch = { ...(merged.webSearch ?? {}), backend: "disabled" };
    if (userConfig.allowedFetchHosts !== undefined && workspaceConfig.allowedFetchHosts !== undefined) merged.allowedFetchHosts = intersectHosts(userConfig.allowedFetchHosts, workspaceConfig.allowedFetchHosts);
  }
  return merged;
}

function intersectHosts(userHosts: string[], workspaceHosts: string[]): string[] {
  if (userHosts.includes("*")) return workspaceHosts;
  if (workspaceHosts.includes("*")) return userHosts;
  const allowed = new Set(userHosts.map((host) => host.toLowerCase()));
  return workspaceHosts.filter((host) => allowed.has(host.toLowerCase()));
}
function deepMergeRuntime(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    result[key] = value !== null && typeof value === "object" && !Array.isArray(value) && current !== null && typeof current === "object" && !Array.isArray(current) ? deepMergeRuntime(current as Record<string, unknown>, value as Record<string, unknown>) : value;
  }
  return result;
}
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

  const webSearchBackend = process.env.AGENT_WEB_SEARCH_BACKEND?.trim();
  if (webSearchBackend === "disabled" || webSearchBackend === "firecrawl") {
    config.webSearch = {
      ...(config.webSearch ?? {}),
      backend: webSearchBackend
    };
  } else if (
    webSearchBackend !== undefined &&
    webSearchBackend.length > 0 &&
    webSearchBackendSchema.safeParse(webSearchBackend).success === false
  ) {
    throw new Error("AGENT_WEB_SEARCH_BACKEND must be a supported web search backend.");
  }

  const webBackend = process.env.AGENT_WEB_BACKEND?.trim();
  if (webBackend !== undefined && webBackend.length > 0) {
    config.web = {
      ...(config.web ?? {}),
      backend: webBackendSchema.parse(webBackend)
    };
  }

  if (webSearchBackend !== undefined && webSearchBackend.length > 0) {
    config.web = {
      ...(config.web ?? {}),
      searchBackend: webSearchBackendSchema.parse(webSearchBackend)
    };
  }

  const webExtractBackend = process.env.AGENT_WEB_EXTRACT_BACKEND?.trim();
  if (webExtractBackend !== undefined && webExtractBackend.length > 0) {
    config.web = {
      ...(config.web ?? {}),
      extractBackend: webExtractBackendSchema.parse(webExtractBackend)
    };
  }

  const firecrawlApiUrl = process.env.FIRECRAWL_API_URL?.trim();
  if (firecrawlApiUrl !== undefined && firecrawlApiUrl.length > 0) {
    config.webSearch = {
      ...(config.webSearch ?? {}),
      apiUrl: firecrawlApiUrl
    };
    config.web = {
      ...(config.web ?? {}),
      providers: {
        ...(config.web?.providers ?? {}),
        firecrawl: {
          ...(config.web?.providers?.firecrawl ?? {}),
          apiUrl: firecrawlApiUrl
        }
      }
    };
  }

  const webSearchMaxResults = readPositiveIntegerEnv("AGENT_WEB_SEARCH_MAX_RESULTS");
  if (webSearchMaxResults !== undefined) {
    config.webSearch = {
      ...(config.webSearch ?? {}),
      maxResults: webSearchMaxResults
    };
    config.web = {
      ...(config.web ?? {}),
      maxResults: webSearchMaxResults
    };
  }

  const searxngUrl = process.env.SEARXNG_URL?.trim();
  if (searxngUrl !== undefined && searxngUrl.length > 0) {
    config.web = {
      ...(config.web ?? {}),
      providers: {
        ...(config.web?.providers ?? {}),
        searxng: {
          ...(config.web?.providers?.searxng ?? {}),
          apiUrl: searxngUrl
        }
      }
    };
  }

  const ddgsUrl = process.env.DDGS_URL?.trim();
  if (ddgsUrl !== undefined && ddgsUrl.length > 0) {
    config.web = {
      ...(config.web ?? {}),
      providers: {
        ...(config.web?.providers ?? {}),
        ddgs: {
          ...(config.web?.providers?.ddgs ?? {}),
          apiUrl: ddgsUrl
        }
      }
    };
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

  const maxShellTimeoutMs = readPositiveIntegerEnv("AGENT_SHELL_MAX_TIMEOUT_MS");
  if (maxShellTimeoutMs !== undefined) {
    config.workflow = {
      ...(config.workflow ?? {}),
      maxShellTimeoutMs
    };
  }

  const shellBackend = process.env.AGENT_SHELL_BACKEND?.trim();
  if (shellBackend !== undefined && shellBackend.length > 0) {
    config.workflow = {
      ...(config.workflow ?? {}),
      shellBackend: shellBackendSchema.parse(shellBackend)
    };
  }

  const memoryEnabled = readBooleanEnv("AGENT_MEMORY_ENABLED");
  if (memoryEnabled !== undefined) {
    config.memory = { ...(config.memory ?? {}), enabled: memoryEnabled };
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

  const teamSkillsHome = process.env.AGENT_TEAM_SKILLS_HOME?.trim();
  if (teamSkillsHome !== undefined && teamSkillsHome.length > 0) {
    const existing = config.skills?.teamRoots ?? [];
    config.skills = {
      ...(config.skills ?? {}),
      teamRoots: [...new Set([...existing, teamSkillsHome])]
    };
  }

  const builtinSkillsRoot = process.env.AGENT_BUILTIN_SKILLS_ROOT?.trim();
  if (builtinSkillsRoot !== undefined && builtinSkillsRoot.length > 0) {
    config.skills = {
      ...(config.skills ?? {}),
      builtinRoot: builtinSkillsRoot
    };
  }

  const skillsPrecedence = splitList(process.env.AGENT_SKILLS_PRECEDENCE).filter(
    (entry): entry is "builtin" | "local" | "project" | "team" =>
      entry === "builtin" || entry === "local" || entry === "project" || entry === "team"
  );
  if (skillsPrecedence.length > 0) {
    config.skills = {
      ...(config.skills ?? {}),
      precedence: skillsPrecedence
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

function resolveWebRuntimeConfig(
  fileConfig: RuntimeConfigFile | null,
  envConfig: Partial<RuntimeConfigFile>,
  legacyWebSearch: WebSearchRuntimeConfig
): WebRuntimeConfig {
  const rawBackend =
    envConfig.web?.backend ??
    fileConfig?.web?.backend ??
    (legacyWebSearch.backend === "firecrawl" ? "firecrawl" : DEFAULT_RUNTIME_CONFIG.web.backend);
  const backend = rawBackend;
  const searchBackend = normalizeSearchBackend(
    envConfig.web?.searchBackend ??
      fileConfig?.web?.searchBackend ??
      (backend !== "http" ? backend : "disabled"),
    legacyWebSearch,
    fileConfig,
    envConfig
  );
  const extractBackend = normalizeExtractBackend(
    envConfig.web?.extractBackend ??
      fileConfig?.web?.extractBackend ??
      (backend === "firecrawl" || backend === "tavily" || backend === "exa" || backend === "auto"
        ? backend
        : DEFAULT_RUNTIME_CONFIG.web.extractBackend)
  );
  const maxResults =
    envConfig.web?.maxResults ??
    fileConfig?.web?.maxResults ??
    legacyWebSearch.maxResults ??
    DEFAULT_RUNTIME_CONFIG.web.maxResults;
  const firecrawlProvider = resolveWebProviderConfig("firecrawl", fileConfig, envConfig);
  const providers = {
    brave: resolveWebProviderConfig("brave", fileConfig, envConfig),
    ddgs: resolveWebProviderConfig("ddgs", fileConfig, envConfig),
    exa: resolveWebProviderConfig("exa", fileConfig, envConfig),
    firecrawl: {
      ...firecrawlProvider,
      apiKey: firecrawlProvider.apiKey ?? legacyWebSearch.apiKey,
      apiKeyEnv: firecrawlProvider.apiKeyEnv ?? legacyWebSearch.apiKeyEnv,
      apiUrl: firecrawlProvider.apiUrl ?? legacyWebSearch.apiUrl
    },
    searxng: resolveWebProviderConfig("searxng", fileConfig, envConfig),
    tavily: resolveWebProviderConfig("tavily", fileConfig, envConfig)
  };

  return {
    backend,
    extractBackend,
    longPageThresholdBytes:
      envConfig.web?.longPageThresholdBytes ??
      fileConfig?.web?.longPageThresholdBytes ??
      DEFAULT_RUNTIME_CONFIG.web.longPageThresholdBytes,
    maxResults,
    providers,
    searchBackend,
    summaryTargetBytes:
      envConfig.web?.summaryTargetBytes ??
      fileConfig?.web?.summaryTargetBytes ??
      DEFAULT_RUNTIME_CONFIG.web.summaryTargetBytes
  };
}

function normalizeSearchBackend(
  backend: WebBackend | WebSearchBackend,
  legacyWebSearch: WebSearchRuntimeConfig,
  fileConfig: RuntimeConfigFile | null,
  envConfig: Partial<RuntimeConfigFile>
): WebSearchBackend {
  if (backend === "http") {
    return "disabled";
  }
  if (backend === "auto") {
    const candidates: Array<keyof WebRuntimeConfig["providers"]> = [
      "firecrawl",
      "tavily",
      "exa",
      "brave",
      "searxng",
      "ddgs"
    ];
    return (
      candidates.find((candidate) =>
        isSearchProviderConfigured(
          candidate,
          legacyWebSearch,
          resolveWebProviderConfig(candidate, fileConfig, envConfig)
        )
      ) ?? "disabled"
    );
  }
  return backend;
}

function normalizeExtractBackend(backend: WebBackend | WebExtractBackend): WebExtractBackend {
  if (backend === "brave" || backend === "ddgs" || backend === "searxng" || backend === "disabled") {
    return "http";
  }
  if (backend === "auto") {
    if (readEnvValue("FIRECRAWL_API_KEY") !== null) {
      return "firecrawl";
    }
    if (readEnvValue("TAVILY_API_KEY") !== null) {
      return "tavily";
    }
    if (readEnvValue("EXA_API_KEY") !== null) {
      return "exa";
    }
    return "http";
  }
  return backend;
}

function isSearchProviderConfigured(
  backend: WebSearchBackend,
  legacyWebSearch: WebSearchRuntimeConfig,
  provider: WebProviderRuntimeConfig
): boolean {
  if (backend === "disabled") {
    return false;
  }
  if (backend === "ddgs") {
    return true;
  }
  if (backend === "searxng") {
    return provider.apiUrl !== null;
  }
  if (backend === "firecrawl") {
    const apiKey = provider.apiKey ?? legacyWebSearch.apiKey;
    return apiKey !== null && provider.apiUrl !== null;
  }
  if (backend === "tavily" || backend === "exa" || backend === "brave") {
    return provider.apiKey !== null && provider.apiUrl !== null;
  }
  return false;
}

function resolveWebProviderConfig(
  provider: keyof WebRuntimeConfig["providers"],
  fileConfig: RuntimeConfigFile | null,
  envConfig: Partial<RuntimeConfigFile>
): WebProviderRuntimeConfig {
  const defaults = DEFAULT_RUNTIME_CONFIG.web.providers[provider];
  const fileProvider = fileConfig?.web?.providers?.[provider];
  const envProvider = envConfig.web?.providers?.[provider];
  const apiKeyEnv = envProvider?.apiKeyEnv ?? fileProvider?.apiKeyEnv ?? defaults.apiKeyEnv;
  return {
    apiKey: apiKeyEnv === null ? null : readEnvValue(apiKeyEnv),
    apiKeyEnv,
    apiUrl: envProvider?.apiUrl ?? fileProvider?.apiUrl ?? defaults.apiUrl
  };
}

function readEnvValue(name: string): string | null {
  return process.env[name]?.trim() || null;
}

function normalizeWorkflowTestCommand(command: WorkflowTestCommand): WorkflowTestCommand | null {
  if (typeof command === "string") {
    const trimmed = command.trim();
    return trimmed.length === 0 ? null : trimmed;
  }

  const name = command.name.trim();
  const shellCommand = command.command.trim();
  if (name.length === 0 || shellCommand.length === 0) {
    return null;
  }
  return {
    ...(command.category !== undefined ? { category: command.category } : {}),
    command: shellCommand,
    name,
    ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {})
  };
}

function normalizeWorkflowLongRunningCommand(
  command: WorkflowLongRunningCommand
): WorkflowLongRunningCommand | null {
  const name = command.name.trim();
  const shellCommand = command.command.trim();
  if (name.length === 0 || shellCommand.length === 0) {
    return null;
  }
  const cwd = command.cwd?.trim();
  const env = command.env === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(command.env)
          .map(([key, value]) => [key.trim(), value] as const)
          .filter(([key]) => key.length > 0)
      );
  return {
    command: shellCommand,
    ...(cwd !== undefined && cwd.length > 0 ? { cwd } : {}),
    ...(env !== undefined && Object.keys(env).length > 0 ? { env } : {}),
    name
  };
}

function normalizeWorkflowCustomShell(
  command: { args?: string[] | undefined; executable: string } | null
): WorkflowCustomShell | null {
  if (command === null) {
    return null;
  }
  const executable = command.executable.trim();
  if (executable.length === 0) {
    return null;
  }
  return {
    args: (command.args ?? []).map((arg) => arg.trim()).filter((arg) => arg.length > 0),
    executable
  };
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

export function writeAuxiliarySlot(cwd: string, slot: AuxiliarySlot, value: string): string {
  if (!AUXILIARY_SLOTS.includes(slot)) {
    throw new Error(`Unknown auxiliary slot "${slot}".`);
  }
  const normalizedValue = value.trim();
  if (normalizedValue.length === 0) {
    throw new Error("Auxiliary slot value is required.");
  }
  if (normalizedValue.toLowerCase() !== "auto") {
    const resolvedSelection = resolveProviderSelectionWithAliases(normalizedValue, cwd);
    const providerConfig = resolveProviderConfigForProvider(cwd, resolvedSelection);
    if (!isProviderSwitchable(providerConfig)) {
      throw new Error(
        `Auxiliary selection "${normalizedValue}" is not a configured provider. Run talon provider setup first.`
      );
    }
  }
  const workspaceRoot = resolve(cwd);
  const configPath = join(workspaceRoot, ".auto-talon", "runtime.config.json");
  const fileConfig = loadRuntimeConfigFile(configPath) ?? {};
  const nextConfig = {
    version: 1,
    ...fileConfig,
    auxiliary: {
      ...DEFAULT_AUXILIARY_CONFIG,
      ...fileConfig.auxiliary,
      [slot]: normalizedValue.toLowerCase() === "auto" ? "auto" : normalizedValue
    }
  };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  return configPath;
}

export function writeMemoryEnabled(cwd: string, enabled: boolean): string {
  const workspaceRoot = resolve(cwd);
  const configPath = join(workspaceRoot, ".auto-talon", "runtime.config.json");
  const fileConfig = loadRuntimeConfigFile(configPath) ?? {};
  const nextConfig = {
    version: 1,
    ...fileConfig,
    memory: {
      ...fileConfig.memory,
      enabled
    }
  };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  return configPath;
}