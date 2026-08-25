import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { DiffDisplayMode } from "../presentation/diff-display.js";
import { ApprovalService } from "../approvals/approval-service.js";
import { ApprovalRuleStore } from "../approvals/approval-rule-store.js";
import { ClarifyService } from "../approvals/clarify-service.js";
import { AuditService } from "../audit/audit-service.js";
import { toAppError } from "../core/app-error.js";
import { ExperienceCollector } from "../experience/experience-collector.js";
import { ExperiencePlane } from "../experience/experience-plane.js";
import { PromotionAdvisor } from "../experience/promotion/promotion-advisor.js";
import { MemoryPlane } from "../memory/memory-plane.js";
import { CoreMemoryService } from "../memory/core-memory-service.js";
import { MemoryFlushService } from "../memory/memory-flush-service.js";
import { MemoryBackgroundReviewService } from "../memory/memory-background-review-service.js";
import { CompactTriggerPolicy } from "../memory/compact-policy.js";
import { createMemorySearchProvider } from "../memory/create-memory-search-provider.js";
import { McpClientManager } from "../mcp/index.js";
import { ContextPolicy } from "../policy/context-policy.js";
import { DEFAULT_LOCAL_POLICY_CONFIG } from "../policy/default-policy-config.js";
import { loadLocalPolicyConfig, PolicyEngine } from "../policy/policy-engine.js";
import { AgentProfileRegistry } from "../profiles/agent-profile-registry.js";
import {
  createAuxiliaryProviderResolver,
  type AuxiliaryRuntimeConfig
} from "../providers/auxiliary-resolver.js";
import {
  createProvider,
  ManagedProvider,
  ProviderRouter,
  resolveProviderCatalog,
  resolveProviderConfig,
  resolveProviderConfigForProvider,
  type ProviderCatalogEntry,
  type ResolvedProviderConfig
} from "../providers/index.js";
import { enrichProviderContextFromApi } from "../providers/context-window-enrichment.js";
import { SandboxService } from "../sandbox/sandbox-service.js";
import { SkillContextService, SkillDraftManager, SkillRegistry } from "../skills/index.js";
import { SkillVersionRegistry } from "../skills/versioning/index.js";
import { StorageManager } from "../storage/database.js";
import { migrateConfigFiles, validateConfigVersions } from "../storage/config-migration.js";
import { RUNTIME_SCHEMA_VERSION, finalizeLegacyThreadMigration } from "../storage/migrations.js";
import { configureSqliteConnection } from "../storage/sqlite-connection.js";
import { TraceService } from "../tracing/trace-service.js";
import type {
  BudgetLimits,
  LocalPolicyConfig,
  Provider,
  RuntimeRunOptions,
  SandboxMode,
  SandboxProfile,
  TokenBudget
} from "../types/index.js";
import {
  AskUserTool,
  CodeSearchTool,
  DelegateTaskTool,
  GlobTool,
  PatchTool,
  ProcessTool,
  ReadFileTool,
  WriteFileTool,
  ShellTool,
  SkillsListTool,
  SkillViewTool,
  TerminalSessionManager,
  ToolOrchestrator,
  ToolRegistry,
  WebFetchTool,
  WebSearchTool,
  SessionSearchTool,
  TodoTool,
  MemoryTool,
  CronjobTool
} from "../tools/index.js";
import { TodoSessionStore } from "../tools/todo-session-store.js";
import { ProviderWebPageSummarizer } from "../tools/web-page-summarizer.js";
import { DockerShellExecutor } from "../tools/shell/docker-shell-executor.js";
import { ShellExecutor } from "../tools/shell/shell-executor.js";
import { resolveToolsetForTool } from "../tools/toolsets.js";
import type { ToolsetName } from "../types/index.js";

import { AgentApplicationService } from "./application-service.js";
import {
  assertLegacyWorkspaceMigrated,
  collectLegacyWorkspaceIssues
} from "./sessions/legacy-workspace.js";
import { ContextCompactor, SessionSearchService, SessionSummaryService } from "./context/index.js";
import { BudgetService } from "./budget/index.js";
import { ManualCompactCoordinator } from "./context/manual-compact-coordinator.js";
import { ExecutionKernel } from "./execution-kernel.js";
import { RuntimeOutputService } from "./runtime-output-service.js";
import { RecallBudgetPolicy, RecallPlanner } from "./retrieval/index.js";
import { DeliveryService } from "./delivery/index.js";
import { WebhookDeliveryService } from "./delivery/webhook-delivery.js";
import { InboxCollector, InboxService } from "./inbox/index.js";
import {
  AssistantSessionProjectionService,
  CommitmentCollector,
  CommitmentService,
  NextActionService,
  SessionCommitmentProjector
} from "./commitments/index.js";
import { JobRunner } from "./jobs/index.js";
import {
  buildScheduledTaskInput,
  readScheduleNoAgent,
  readScheduleToolsets,
  scanCronSkillPrompt,
  resolveScheduleSessionId,
  runNoAgentCommand,
  verifyScheduledSkills,
  SchedulerService,
  ScheduleRunLifecycle
} from "./scheduler/index.js";
import { ResumePacketBuilder, SessionService, SessionStateProjector } from "./sessions/index.js";
import { SessionExecutionLock } from "./sessions/session-execution-lock.js";
import {
  SessionBranchService,
  SessionHandoffService,
  SessionIndexService,
  SessionMessageProjector,
  SessionMessageSearchService,
  SessionUiStateService
} from "./sessions/index.js";
import { RetrievalWorker, SummarizerWorker, WorkerDispatcher } from "./workers/index.js";
import type { ContextRetentionConfig } from "./context/recent-file-reads.js";
import {
  resolveRuntimeConfig,
  type RuntimeConfig,
  type TuiStatusLineConfig,
  type WebRuntimeConfig,
  type WebSearchRuntimeConfig,
  type WorkflowCustomShell,
  type WorkflowRuntimeConfig
} from "./runtime-config.js";
import { ToolOverrideStore } from "../tools/tool-overrides.js";
import { ToolExposurePlanner } from "./tool-exposure-planner.js";
import { ensureWorkspaceState, resolveWorkspaceLayout, type WorkspaceMode } from "./workspace-layout.js";
import { resolveDefaultUserId } from "./runtime-identity.js";

export const RUNTIME_VERSION = "0.1.1";

export const DEFAULT_UNKNOWN_CONTEXT_WINDOW_FALLBACK_TOKENS = 32_000;

export function resolveEffectiveContextWindow(
  provider: ResolvedProviderConfig,
  runtimeConfig: Pick<
    RuntimeConfig,
    "tokenBudget" | "tokenBudgetInputLimitExplicit" | "unknownContextWindowFallback"
  >
): { provider: ResolvedProviderConfig; tokenBudget: TokenBudget } {
  if (runtimeConfig.tokenBudgetInputLimitExplicit) {
    if (
      provider.contextWindowTokens !== null &&
      runtimeConfig.tokenBudget.inputLimit > provider.contextWindowTokens
    ) {
      console.warn(
        `Warning: tokenBudget.inputLimit (${runtimeConfig.tokenBudget.inputLimit}) exceeds ` +
          `provider ${provider.name} context window (${provider.contextWindowTokens}).`
      );
    }
    const tokenBudget = assertTokenBudgetCoherent(runtimeConfig.tokenBudget);
    return {
      provider: {
        ...provider,
        contextWindowSource: "explicit_token_budget",
        contextWindowTokens: tokenBudget.inputLimit
      },
      tokenBudget
    };
  }

  if (provider.configured === false) {
    return {
      provider,
      tokenBudget: assertTokenBudgetCoherent(runtimeConfig.tokenBudget)
    };
  }

  if (provider.contextWindowTokens === null) {
    const fallbackLimit = runtimeConfig.unknownContextWindowFallback;
    console.warn(
      `Warning: provider ${provider.name} model ${provider.model ?? "-"} is missing contextWindowTokens. ` +
        `Using fallback input limit ${fallbackLimit}. ` +
        "Set providers.<name>.contextWindowTokens, tokenBudget.inputLimit, or tokenBudget.unknownContextWindowFallback explicitly."
    );
    const tokenBudget = assertTokenBudgetCoherent({
      ...runtimeConfig.tokenBudget,
      inputLimit: fallbackLimit
    });
    return {
      provider: {
        ...provider,
        contextWindowSource: provider.contextWindowSource ?? "provider_manifest",
        contextWindowTokens: fallbackLimit
      },
      tokenBudget
    };
  }

  const tokenBudget = assertTokenBudgetCoherent({
    ...runtimeConfig.tokenBudget,
    inputLimit: provider.contextWindowTokens
  });

  return {
    provider,
    tokenBudget
  };
}

function assertTokenBudgetCoherent(tokenBudget: TokenBudget): TokenBudget {
  if (tokenBudget.reservedOutput >= tokenBudget.inputLimit) {
    throw new Error(
      `tokenBudget.reservedOutput (${tokenBudget.reservedOutput}) must be less than ` +
        `tokenBudget.inputLimit (${tokenBudget.inputLimit}).`
    );
  }
  return tokenBudget;
}

function createCustomShellExecutor(customShell: WorkflowCustomShell | null): ShellExecutor {
  if (customShell === null) {
    throw new Error("workflow.customShell.executable is required when workflow.shellBackend is custom.");
  }
  return new ShellExecutor({
    shellArgs: customShell.args,
    shellExecutable: customShell.executable
  });
}

export interface AppConfig {
  approvalTtlMs: number;
  allowedFetchHosts: string[];
  databasePath: string;
  configRoot: string | null;
  configSources: Record<string, string>;
  defaultInteractionMode: "agent" | "plan" | "acceptEdits";
  defaultMaxIterations: number;
  defaultProfileId: "executor" | "planner" | "reviewer";
  defaultTimeoutMs: number;
  interactionModes: RuntimeConfig["interactionModes"];
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
  context: RuntimeConfig["context"];
  contextRetention: ContextRetentionConfig;
  memory: RuntimeConfig["memory"];
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
  skills: {
    builtinRoot: string | null;
    precedence: Array<"builtin" | "local" | "project" | "team">;
    teamRoots: string[];
  };
  routing: {
    mode: "cheap_first" | "balanced" | "quality_first";
    providers: {
      cheap?: string;
      balanced?: string;
      quality?: string;
    };
    helpers: {
      summarize: "cheap" | "balanced" | "quality" | null;
      classify: "cheap" | "balanced" | "quality" | null;
      recallRank: "cheap" | "balanced" | "quality" | null;
    };
  };
  auxiliary: AuxiliaryRuntimeConfig;
  budget: {
    task: BudgetLimits;
    session: BudgetLimits;
    pricing: Record<
      string,
      { inputPerMillion: number; outputPerMillion: number; cachedInputPerMillion?: number | undefined }
    >;
  };
  provider: ResolvedProviderConfig;
  runtimeVersion: string;
  runtimeConfigPath: string;
  runtimeConfigSource: "defaults" | "env" | "file";
  sandbox: SandboxProfile;
  tokenBudget: TokenBudget;
  tokenBudgetInputLimitExplicit: boolean;
  unknownContextWindowFallback: number;
  concurrency: {
    allowParallelSessions: boolean;
  };
  tui: {
    diffDisplay: DiffDisplayMode;
    statusLine: TuiStatusLineConfig;
  };
  webSearch: WebSearchRuntimeConfig;
  web: WebRuntimeConfig;
  workflow: WorkflowRuntimeConfig;
  workspaceRoot: string;
  workingDirectory: string;
  stateRoot: string;
  initializedWorkspaceRoot: string | null;
  workspaceMode: WorkspaceMode;
  scheduler: {
    pollIntervalMs: number;
  };
}

export interface ResolveAppConfigOptions {
  sandboxMode?: SandboxMode;
  sandboxProfile?: string;
  writeRoots?: string[];
}

export function resolveAppConfig(cwd = process.cwd(), options: ResolveAppConfigOptions = {}): AppConfig {
  const layout = resolveWorkspaceLayout(cwd);
  ensureWorkspaceState(layout);
  const workspaceRoot = layout.workspaceRoot ?? layout.workingDirectory;
  if (layout.workspaceRoot !== null) {
    migrateConfigFiles(layout.workspaceRoot);
    validateConfigVersions(layout.workspaceRoot);
  }
  const provider = resolveProviderConfig(workspaceRoot);
  const sandbox = resolveSandboxProfile(workspaceRoot, options);
  const runtimeConfig = resolveRuntimeConfig(workspaceRoot);

  return {
    approvalTtlMs: runtimeConfig.approvalTtlMs,
    allowedFetchHosts: runtimeConfig.allowedFetchHosts,
    databasePath:
      process.env.AGENT_RUNTIME_DB_PATH ??
      join(layout.stateRoot, "agent-runtime.db"),
    configRoot: layout.configRoot,
    configSources: { provider: provider.configPath, runtime: runtimeConfig.configPath },
    defaultInteractionMode: runtimeConfig.defaultInteractionMode,
    defaultMaxIterations: runtimeConfig.defaultMaxIterations,
    defaultProfileId: "executor",
    defaultTimeoutMs: runtimeConfig.defaultTimeoutMs,
    interactionModes: runtimeConfig.interactionModes,
    compact: runtimeConfig.compact,
    context: runtimeConfig.context,
    contextRetention: runtimeConfig.contextRetention,
    memory: runtimeConfig.memory,
    recall: runtimeConfig.recall,
    promotion: runtimeConfig.promotion,
    skills: runtimeConfig.skills,
    routing: runtimeConfig.routing,
    auxiliary: runtimeConfig.auxiliary,
    budget: runtimeConfig.budget,
    provider,
    runtimeVersion: RUNTIME_VERSION,
    runtimeConfigPath: runtimeConfig.configPath,
    runtimeConfigSource: runtimeConfig.configSource,
    sandbox,
    tokenBudget: runtimeConfig.tokenBudget,
    tokenBudgetInputLimitExplicit: runtimeConfig.tokenBudgetInputLimitExplicit,
    unknownContextWindowFallback: runtimeConfig.unknownContextWindowFallback,
    concurrency: runtimeConfig.concurrency,
    tui: runtimeConfig.tui,
    webSearch: runtimeConfig.webSearch,
    web: runtimeConfig.web,
    workflow: runtimeConfig.workflow,
    scheduler: runtimeConfig.scheduler,
    workingDirectory: layout.workingDirectory,
    stateRoot: layout.stateRoot,
    initializedWorkspaceRoot: layout.workspaceRoot,
    workspaceMode: layout.workspaceMode,
    workspaceRoot
  };
}

export interface AppRuntimeHandle {
  close: () => void;
  config: AppConfig;
  infrastructure: {
    mcpClientManager: McpClientManager;
    approvalService: ApprovalService;
    auditService: AuditService;
    createRunOptions: (taskInput: string, cwd: string) => RuntimeRunOptions;
    skillRegistry: SkillRegistry;
    sessionService: SessionService;
    toolOrchestrator: ToolOrchestrator;
    traceService: TraceService;
    storage: StorageManager;
  };
  service: AgentApplicationService;
}

export interface CreateApplicationOptions {
  config?: Partial<AppConfig>;
  policyConfig?: LocalPolicyConfig;
  provider?: Provider;
  providerCatalog?: ProviderCatalogEntry[];
  scheduler?: {
    autoStart?: boolean;
  };
  sandbox?: ResolveAppConfigOptions;
  allowLegacyWorkspace?: boolean;
}

export function createApplication(
  cwd = process.cwd(),
  options: CreateApplicationOptions = {}
): AppRuntimeHandle {
  const resolvedConfig = resolveAppConfig(cwd, options.sandbox);
  backupDatabaseIfMigrationNeeded(resolvedConfig.workspaceRoot, resolvedConfig.databasePath);
  const mergedConfig = mergeCreateApplicationConfig(resolvedConfig, options);
  const effectiveContext = resolveEffectiveContextWindow(mergedConfig.provider, mergedConfig);
  const config = {
    ...mergedConfig,
    provider: effectiveContext.provider,
    tokenBudget: effectiveContext.tokenBudget
  };
  const provider =
    options.provider === undefined
      ? createProvider(config.provider)
      : new ManagedProvider(options.provider, config.provider);

  return buildApplicationRuntime(config, provider, options);
}

export async function createApplicationAsync(
  cwd = process.cwd(),
  options: CreateApplicationOptions = {}
): Promise<AppRuntimeHandle> {
  const resolvedConfig = resolveAppConfig(cwd, options.sandbox);
  backupDatabaseIfMigrationNeeded(resolvedConfig.workspaceRoot, resolvedConfig.databasePath);
  const mergedConfig = mergeCreateApplicationConfig(resolvedConfig, options);
  const probeProvider =
    options.provider === undefined ? createProvider(mergedConfig.provider) : options.provider;
  const enrichedProvider = await enrichProviderContextFromApi(
    probeProvider,
    mergedConfig.provider,
    mergedConfig
  );
  const effectiveContext = resolveEffectiveContextWindow(enrichedProvider, mergedConfig);
  const config = {
    ...mergedConfig,
    provider: effectiveContext.provider,
    tokenBudget: effectiveContext.tokenBudget
  };
  const provider =
    options.provider === undefined
      ? probeProvider
      : new ManagedProvider(options.provider, config.provider);

  return buildApplicationRuntime(config, provider, options);
}

function mergeCreateApplicationConfig(
  resolvedConfig: AppConfig,
  options: CreateApplicationOptions
): AppConfig {
  const configuredWorkspaceRoot = options.config?.workspaceRoot ?? resolvedConfig.workspaceRoot;
  const resolvedSandbox =
    configuredWorkspaceRoot === resolvedConfig.workspaceRoot
      ? resolvedConfig.sandbox
      : resolveSandboxProfile(configuredWorkspaceRoot, options.sandbox ?? {});

  return {
    ...resolvedConfig,
    ...options.config,
    budget: {
      ...resolvedConfig.budget,
      ...options.config?.budget,
      pricing: {
        ...resolvedConfig.budget.pricing,
        ...options.config?.budget?.pricing
      },
      session: {
        ...resolvedConfig.budget.session,
        ...options.config?.budget?.session
      },
      task: {
        ...resolvedConfig.budget.task,
        ...options.config?.budget?.task
      }
    },
    compact: {
      ...resolvedConfig.compact,
      ...options.config?.compact
    },
    context: {
      ...resolvedConfig.context,
      ...options.config?.context
    },
    contextRetention: {
      ...resolvedConfig.contextRetention,
      ...options.config?.contextRetention
    },
    memory: {
      ...resolvedConfig.memory,
      ...options.config?.memory,
      core: { ...resolvedConfig.memory.core, ...options.config?.memory?.core },
      flush: { ...resolvedConfig.memory.flush, ...options.config?.memory?.flush },
      search: {
        ...resolvedConfig.memory.search,
        ...options.config?.memory?.search,
        openaiCompatible: {
          ...resolvedConfig.memory.search.openaiCompatible,
          ...options.config?.memory?.search?.openaiCompatible
        }
      }
    },
    recall: {
      ...resolvedConfig.recall,
      ...options.config?.recall
    },
    promotion: {
      ...resolvedConfig.promotion,
      ...options.config?.promotion
    },
    skills: {
      ...resolvedConfig.skills,
      ...options.config?.skills
    },
    routing: {
      ...resolvedConfig.routing,
      ...options.config?.routing,
      helpers: {
        ...resolvedConfig.routing.helpers,
        ...options.config?.routing?.helpers
      },
      providers: {
        ...resolvedConfig.routing.providers,
        ...options.config?.routing?.providers
      }
    },
    auxiliary: {
      ...resolvedConfig.auxiliary,
      ...options.config?.auxiliary
    },
    sandbox: {
      ...resolvedSandbox,
      ...options.config?.sandbox
    },
    tokenBudget: {
      ...resolvedConfig.tokenBudget,
      ...options.config?.tokenBudget
    },
    tokenBudgetInputLimitExplicit:
      options.config?.tokenBudget?.inputLimit !== undefined
        ? true
        : resolvedConfig.tokenBudgetInputLimitExplicit,
    webSearch: {
      ...resolvedConfig.webSearch,
      ...options.config?.webSearch
    },
    web: {
      ...resolvedConfig.web,
      ...options.config?.web,
      providers: {
        ...resolvedConfig.web.providers,
        ...options.config?.web?.providers
      }
    },
    workflow: {
      ...resolvedConfig.workflow,
      ...options.config?.workflow,
      failureGuidedRetry: {
        ...resolvedConfig.workflow.failureGuidedRetry,
        ...options.config?.workflow?.failureGuidedRetry
      },
      repoMap: {
        ...resolvedConfig.workflow.repoMap,
        ...options.config?.workflow?.repoMap
      }
    }
  };
}

function buildApplicationRuntime(
  config: AppConfig,
  provider: Provider,
  options: CreateApplicationOptions
): AppRuntimeHandle {
  const storage = new StorageManager({
    databasePath: config.databasePath
  });
  if (options.allowLegacyWorkspace !== true) {
    assertLegacyWorkspaceMigrated(config.workspaceRoot, storage.database);
  }
  const traceService = new TraceService(storage.traces);
  const outputService = new RuntimeOutputService(storage.outputs, (taskId) => storage.tasks.findById(taskId));
  const stopOutputTraceProjection = traceService.subscribe((event) => outputService.projectTrace(event));
  const auditService = new AuditService(storage.auditLogs);
  const budgetService = new BudgetService(config.budget, traceService, auditService);
  budgetService.start();
  const mainProviderRef = { current: provider };
  const routedProviders = new Map<string, Provider>();
  const providerRouter = new ProviderRouter(
    config.routing,
    (providerName) => {
      if (providerName === mainProviderRef.current.name) {
        return mainProviderRef.current;
      }
      const existing = routedProviders.get(providerName);
      if (existing !== undefined) {
        return existing;
      }
      const routedProvider = createProvider(
        resolveProviderConfigForProvider(config.workspaceRoot, providerName)
      );
      routedProviders.set(providerName, routedProvider);
      return routedProvider;
    },
    budgetService,
    traceService,
    auditService
  );
  const approvalService = new ApprovalService(storage.approvals, {
    approvalTtlMs: config.approvalTtlMs
  });
  const clarifyService = new ClarifyService(storage.clarifyPrompts, {
    clarifyTtlMs: config.approvalTtlMs
  });
  const approvalRuleStore = new ApprovalRuleStore(config.workspaceRoot);
  const contextPolicy = new ContextPolicy();
  const policyEngine = new PolicyEngine(
    options.policyConfig ?? loadLocalPolicyConfig(config.workspaceRoot) ?? DEFAULT_LOCAL_POLICY_CONFIG
  );
  const agentProfileRegistry = new AgentProfileRegistry();
  const sandboxService = new SandboxService({
    allowedEnvKeys: ["CI", "FORCE_COLOR", "NODE_ENV", "NO_COLOR"],
    allowedFetchHosts: config.allowedFetchHosts,
    ...(config.sandbox.shellAllowlist.length > 0
      ? { allowedShellCommands: config.sandbox.shellAllowlist }
      : {}),
    readRoots: config.sandbox.readRoots,
    shellNetworkAccess: config.sandbox.network === "disabled" ? "disabled" : "unrestricted",
    maxShellTimeoutMs: config.workflow.maxShellTimeoutMs,
    workspaceRoot: config.workspaceRoot,
    writeRoots: config.sandbox.writeRoots
  });
  const shellExecutor =
    config.sandbox.mode === "docker" || config.workflow.shellBackend === "docker-sh"
      ? new DockerShellExecutor({
          dockerImage: config.sandbox.dockerImage ?? "alpine:3.20",
          readRoots: config.sandbox.readRoots,
          workspaceRoot: config.workspaceRoot,
          writeRoots: config.sandbox.writeRoots
        })
      : config.workflow.shellBackend === "custom"
        ? createCustomShellExecutor(config.workflow.customShell)
        : new ShellExecutor({ shellBackend: config.workflow.shellBackend });
  const skillRegistry = new SkillRegistry({
    ...(config.skills.builtinRoot !== null ? { builtinSkillsRoot: config.skills.builtinRoot } : {}),
    precedence: config.skills.precedence,
    teamSkillRoots: config.skills.teamRoots,
    workspaceRoot: config.workspaceRoot
  });
  const mcpClientManager = new McpClientManager(config.workspaceRoot);
  const sessionMessageSearchService = new SessionMessageSearchService({
    messageRepository: storage.sessionMessages
  });
  const mcpTools = mcpClientManager.discover();
  let toolRegistryRef: ToolRegistry | null = null;
  const skillVersionRegistry = new SkillVersionRegistry(config.workspaceRoot);
  const skillDraftManager = new SkillDraftManager({
    auditService,
    skillVersionRegistry,
    teamSkillRoots: config.skills.teamRoots,
    workspaceRoot: config.workspaceRoot
  });
  const skillContextService = new SkillContextService({
    registry: skillRegistry
  });
  const terminalSessionManager = new TerminalSessionManager();
  const todoSessionStore = new TodoSessionStore(storage.sessionTodos);
  const delegateTaskTool = new DelegateTaskTool();
  const cronjobTool = new CronjobTool();
  const auxiliaryProviderResolver = createAuxiliaryProviderResolver({
    auxiliary: config.auxiliary,
    createProvider: (providerConfig) => createProvider(providerConfig),
    cwd: config.workspaceRoot,
    mainProviderRef,
    providerRouter
  });
  const summarizeEnabled =
    config.auxiliary.summarize !== "auto" || config.routing.helpers.summarize !== null;
  const webPageSummarizer = summarizeEnabled
    ? new ProviderWebPageSummarizer(
        (context) => auxiliaryProviderResolver.resolve("summarize", context),
        provider
      )
    : undefined;
  const toolRegistry = new ToolRegistry().registerAll([
    new AskUserTool(),
    new CodeSearchTool(sandboxService),
    delegateTaskTool,
    new GlobTool(sandboxService),
    new PatchTool(sandboxService),
    new ReadFileTool(sandboxService),
    new WriteFileTool(sandboxService),
    new ProcessTool(terminalSessionManager, sandboxService, config.workflow.longRunningCommands),
    new SkillsListTool(skillRegistry),
    new SkillViewTool(skillRegistry),
    new ShellTool(shellExecutor, sandboxService),
    new WebFetchTool(sandboxService, undefined, config.web, undefined, webPageSummarizer),
    new WebSearchTool(sandboxService, config.web),
    new SessionSearchTool({ searchService: sessionMessageSearchService }),
    new MemoryTool({
      enabled: () => resolveRuntimeConfig(config.workspaceRoot).memory.enabled,
      inboxRepository: storage.inbox,
      memoryRepository: storage.memories
    }),
    new TodoTool(todoSessionStore),
    cronjobTool,
    ...mcpClientManager.createCatalogTools((tool) => {
      if (toolRegistryRef !== null && !toolRegistryRef.has(tool.name)) {
        toolRegistryRef.register(tool);
      }
    }),
    ...mcpTools
  ]);
  toolRegistryRef = toolRegistry;
  const toolOrchestrator = new ToolOrchestrator({
    approvalService,
    approvalRuleStore,
    artifactRepository: storage.artifacts,
    auditService,
    clarifyService,
    contextPolicy,
    policyEngine,
    toolCallRepository: storage.toolCalls,
    toolRegistry,
    traceService
  });
  const memorySearchProvider = createMemorySearchProvider({
    database: storage.database,
    memoryEmbeddings: storage.memoryEmbeddings,
    memoryRepository: storage.memories,
    openaiCompatible: config.memory.search.openaiCompatible,
    provider: config.memory.search.provider
  });
  const memoryPlane = new MemoryPlane({
    contextPolicy,
    memoryRepository: storage.memories,
    memorySnapshotRepository: storage.memorySnapshots,
    searchProvider: memorySearchProvider,
    traceService
  });
  const experiencePlane = new ExperiencePlane({
    experienceRepository: storage.experiences,
    memoryPlane,
    traceService
  });
  const experienceCollector = new ExperienceCollector({
    experiencePlane,
    traceService
  });
  experienceCollector.start();
  const promotionAdvisor = new PromotionAdvisor({
    auditService,
    config: config.promotion,
    experiencePlane,
    skillDraftManager,
    skillVersionRegistry,
    traceService
  });
  promotionAdvisor.start();
  const recallBudgetPolicy = new RecallBudgetPolicy({
    budgetRatio: config.recall.budgetRatio
  });
  const coreMemoryService = new CoreMemoryService(
    storage.memories,
    storage.sessionCoreSnapshots,
    config.memory.core
  );
  const recallPlanner = new RecallPlanner({
    budgetPolicy: recallBudgetPolicy,
    contextPolicy,
    coreMemoryService,
    enabled: () => config.recall.enabled && resolveRuntimeConfig(config.workspaceRoot).memory.enabled,
    experiencePlane,
    maxCandidatesPerScope: config.recall.maxCandidatesPerScope,
    memoryPlane,
    sessionSearchService: new SessionSearchService({
      repository: storage.sessionSummaries
    }),
    skillContextService,
    traceService
  });
  const contextCompactor = new ContextCompactor();
  const compactPolicy = new CompactTriggerPolicy();
  const sessionSummaryService = new SessionSummaryService({
    repository: storage.sessionSummaries,
    traceService
  });
  const workerDispatcher = new WorkerDispatcher({
    auditService,
    budgetService,
    traceService
  });
  const summarizerWorker = new SummarizerWorker({
    contextCompactor,
    sessionMessageRepository: storage.sessionMessages,
    sessionSummaryService
  });
  const retrievalWorker = new RetrievalWorker({
    recallPlanner
  });
  const deliveryService = new DeliveryService();
  const webhookDeliveryService = new WebhookDeliveryService({
    onFailure: ({ errorMessage, runId, scheduleId, webhookUrl }) => {
      auditService.record({
        action: "tool_failure",
        actor: "delivery.webhook",
        approvalId: null,
        outcome: "failed",
        payload: {
          errorMessage,
          runId,
          scheduleId,
          webhookUrl
        },
        summary: `Schedule webhook failed for ${scheduleId}`,
        taskId: `schedule:${scheduleId}`,
        toolCallId: null
      });
    }
  });
  const deliveryProducer = deliveryService.createProducer();
  const inboxService = new InboxService({
    deliveryProducer,
    deliveryProducerKey: deliveryService.producerKey(),
    deliveryService,
    inboxRepository: storage.inbox,
    traceService
  });
  const commitmentService = new CommitmentService({
    commitmentRepository: storage.commitments,
    traceService
  });
  const nextActionService = new NextActionService({
    nextActionRepository: storage.nextActions,
    traceService
  });
  const inboxCollector = new InboxCollector({
    findSchedule: (scheduleId) => storage.schedules.findById(scheduleId),
    findScheduleRun: (runId) => storage.scheduleRuns.findById(runId),
    findTask: (taskId) => storage.tasks.findById(taskId),
    inboxService,
    listScheduleRunsByTask: (taskId) => storage.scheduleRuns.listByTaskId(taskId),
    nextActionService,
    traceService,
    webhookDelivery: webhookDeliveryService
  });
  inboxCollector.start();
  const sessionCommitmentProjector = new SessionCommitmentProjector({
    commitmentService,
    nextActionService,
    sessionSummaryService
  });
  const commitmentCollector = new CommitmentCollector({
    commitmentService,
    findTask: (taskId) => storage.tasks.findById(taskId),
    nextActionService,
    sessionSummaryService,
    traceService
  });
  commitmentCollector.start();
  const assistantSessionProjectionService = new AssistantSessionProjectionService({
    commitmentService,
    nextActionService
  });
  const toolOverrideStore = new ToolOverrideStore(config.workspaceRoot);
  const toolExposurePlanner = new ToolExposurePlanner({
    budgetService,
    toolOrchestrator,
    toolOverrideStore,
    traceService
  });
  const sessionService = new SessionService({
    sessionLineageRepository: storage.sessionLineage,
    sessionRepository: storage.sessions,
    sessionTaskRepository: storage.sessionTasks
  });
  const sessionUiStateService = new SessionUiStateService({
    messageRepository: storage.sessionMessages,
    sessionRepository: storage.sessions
  });
  const sessionBranchService = new SessionBranchService({
    sessionLineageRepository: storage.sessionLineage,
    sessionRepository: storage.sessions,
    sessionSummaryService,
    sessionUiStateService,
    todoSessionStore
  });
  const sessionHandoffService = new SessionHandoffService({
    gatewaySessionRepository: storage.gatewaySessions,
    sessionRepository: storage.sessions
  });
  const sessionMessageProjector = new SessionMessageProjector(
    storage.sessionMessages,
    storage.sessions
  );
  const sessionIndexService = new SessionIndexService({
    messageRepository: storage.sessionMessages,
    sessionRepository: storage.sessions
  });

  const manualCompactCoordinator = new ManualCompactCoordinator();

  const memoryFlushService = new MemoryFlushService({
    enabled: () => {
      const current = resolveRuntimeConfig(config.workspaceRoot);
      return current.memory.enabled && current.memory.flush.enabled;
    },
    maxSuggestions: config.memory.flush.maxSuggestions,
    toolOrchestrator,
    workspaceRoot: config.workspaceRoot
  });
  const memoryBackgroundReviewService = new MemoryBackgroundReviewService({
    enabled: () => resolveRuntimeConfig(config.workspaceRoot).memory.enabled,
    maxSuggestions: config.memory.flush.maxSuggestions,
    toolOrchestrator,
    workspaceRoot: config.workspaceRoot
  });
  const executionKernel = new ExecutionKernel({
    auditService,
    auxiliaryProviderResolver,
    compact: config.compact,
    contextRetention: config.contextRetention,
    compactPolicy,
    agentProfileRegistry,
    budgetPricing: config.budget.pricing,
    budgetService,
    executionCheckpointRepository: storage.checkpoints,
    contextCompactor,
    getSessionCommitmentState: (sessionId) => sessionCommitmentProjector.project(sessionId),
    manualCompactCoordinator,
    memoryPlane,
    memoryFlushService,
    memoryBackgroundReviewService,
    recallPlanner,
    provider,
    providerRouter,
    runMetadataRepository: storage.runMetadata,
    routingMode: config.routing.mode,
    runtimeVersion: config.runtimeVersion,
    sessionSummaryService,
    workerDispatcher,
    summarizerWorker,
    retrievalWorker,
    taskRepository: storage.tasks,
    sessionLineageRepository: storage.sessionLineage,
    sessionMessageRepository: storage.sessionMessages,
    sessionTaskRepository: storage.sessionTasks,
    sessionTranscriptRepository: storage.sessionTranscripts,
    sessionMessageProjector,
    skillContextService,
    toolExposurePlanner,
    toolOrchestrator,
    todoSessionStore,
    traceService,
    outputService,
    workflow: config.workflow,
    interactionModes: config.interactionModes,
    webSearchBackend: config.web.searchBackend,
    workspaceRoot: config.workspaceRoot
  });
  delegateTaskTool.bindExecutor(async (request) => {
    const parentTask = storage.tasks.findById(request.parentTaskId);
    const result = await executionKernel.run({
      agentProfileId: request.profile ?? config.defaultProfileId,
      cwd: request.cwd,
      interactionMode: "agent",
      maxIterations: request.maxIterations ?? config.defaultMaxIterations,
      metadata: {
        delegateIsolation: request.isolation === true,
        delegatedFromTaskId: request.parentTaskId
      },
      ...(request.isolation !== true &&
      parentTask?.sessionId !== null &&
      parentTask?.sessionId !== undefined
        ? { sessionId: parentTask.sessionId }
        : {}),
      signal: request.signal,
      taskInput: request.prompt,
      timeoutMs: config.defaultTimeoutMs,
      tokenBudget: {
        ...config.tokenBudget,
        usedCostUsd: 0,
        usedInput: 0,
        usedOutput: 0
      },
      userId: request.userId
    });
    return {
      output: result.output,
      status: result.task.status,
      taskId: result.task.taskId
    };
  });
  const sessionStateProjector = new SessionStateProjector({
    commitmentProjector: sessionCommitmentProjector,
    sessionMessageRepository: storage.sessionMessages,
    sessionSummaryService,
    sessionTranscriptRepository: storage.sessionTranscripts,
    resumeUserTailMessages: config.compact.resumeUserTailMessages,
    tailMinMessages: config.compact.tailMinMessages,
    tailTokenBudget: config.compact.tailTokenBudget
  });
  const resumePacketBuilder = new ResumePacketBuilder({
    config,
    sessionTaskRepository: storage.sessionTasks,
    stateProjector: sessionStateProjector,
    taskRepository: storage.tasks
  });
  let service: AgentApplicationService | null = null;
  const schedulerRef: { current: SchedulerService | null } = { current: null };
  const scheduleRunLifecycle = new ScheduleRunLifecycle({
    onCompleted: (scheduleId) => {
      const schedule = storage.schedules.findById(scheduleId);
      if (schedule !== null) {
        schedulerRef.current?.handleRepeatAfterSuccess(schedule);
      }
    },
    scheduleRunRepository: storage.scheduleRuns
  });
  const sessionExecutionLock = new SessionExecutionLock(storage.database, {
    allowParallelSessions: config.concurrency.allowParallelSessions
  });
  const jobRunner = new JobRunner({
    scheduleRepository: storage.schedules,
    scheduleRunRepository: storage.scheduleRuns,
    traceService,
    execute: async ({ run, schedule }) => {
      if (service === null) {
        throw new Error("Application service has not been initialized.");
      }
      const scheduleToolsets = readScheduleToolsets(schedule);
      const skillVerification = verifyScheduledSkills(schedule, skillRegistry);
      storage.scheduleRuns.update(run.runId, {
        metadata: {
          ...run.metadata,
          deliveryVerification: {
            targets: readDeliveryVerificationTargets(schedule.metadata)
          },
          skillVerification
        }
      });
      traceService.record({
        actor: "scheduler",
        eventType: "skill_context_loaded",
        payload: {
          loadedSkills: skillVerification.loadedSkills,
          missingSkillIds: skillVerification.missingSkillIds,
          runId: run.runId,
          scheduleId: schedule.scheduleId
        },
        stage: "memory",
        summary: `Loaded ${skillVerification.loadedSkills.length} scheduled skill(s)`,
        taskId: `schedule:${schedule.scheduleId}`
      });
      if (skillVerification.missingSkillIds.length > 0) {
        throw new Error(`Scheduled run missing required skill(s): ${skillVerification.missingSkillIds.join(", ")}`);
      }
      const taskInput = buildScheduledTaskInput(schedule, skillRegistry);
      const guard = scanCronSkillPrompt(taskInput);
      if (!guard.safe) {
        throw new Error(guard.reason ?? "Scheduled prompt failed security scan.");
      }
      assertScheduleToolsetsAvailable(scheduleToolsets, toolOrchestrator);
      try {
        const runResult = await service.runTask({
          agentProfileId: schedule.agentProfileId,
          cwd: schedule.cwd,
          maxIterations: config.defaultMaxIterations,
          metadata: {
            scheduleRunContext: {
              disallowScheduleManagement: true,
              runId: run.runId,
              scheduleId: schedule.scheduleId
            },
            ...(schedule.metadata.allowDelegate === true ? { allowDelegate: true } : {}),
            ...(scheduleToolsets.length > 0 ? { scheduleToolsets } : {})
          },
          taskInput,
          ...(resolveScheduleSessionId(schedule) !== null
            ? { sessionId: resolveScheduleSessionId(schedule)! }
            : {}),
          timeoutMs: config.defaultTimeoutMs,
          tokenBudget: {
            ...config.tokenBudget,
            usedInput: 0,
            usedOutput: 0,
            usedCostUsd: 0
          },
          userId: schedule.ownerUserId
        });
        return runResult;
      } catch (error) {
        const appError = toAppError(error);
        if (appError.code === "session_busy") {
          storage.scheduleRuns.update(run.runId, {
            errorMessage: appError.message,
            scheduledAt: new Date(Date.now() + 30_000).toISOString(),
            status: "queued"
          });
          traceService.record({
            actor: "scheduler",
            eventType: "schedule_run_skipped_overlap",
            payload: {
              activeRunId: run.runId,
              reason: "scheduled",
              scheduleId: schedule.scheduleId
            },
            stage: "control",
            summary: `Deferred schedule run ${run.runId} because session is busy`,
            taskId: `schedule:${schedule.scheduleId}`
          });
        }
        throw error;
      }
    },
    executeNoAgent: async ({ schedule }) => {
      const noAgent = readScheduleNoAgent(schedule);
      if (noAgent === null) {
        throw new Error(`Schedule ${schedule.scheduleId} is missing noAgent metadata.`);
      }
      return runNoAgentCommand(noAgent, schedule.cwd);
    },
    onRunCompleted: (schedule, status) => {
      if (status === "completed") {
        schedulerRef.current?.handleRepeatAfterSuccess(schedule);
      }
    }
  });
  const schedulerService = new SchedulerService({
    jobRunner,
    pollIntervalMs: config.scheduler.pollIntervalMs,
    scheduleRepository: storage.schedules,
    scheduleRunRepository: storage.scheduleRuns,
    traceService
  });
  schedulerRef.current = schedulerService;
  cronjobTool.bindPort({
    archiveSchedule: (scheduleId) => schedulerService.archiveSchedule(scheduleId),
    createSchedule: (input) =>
      schedulerService.createSchedule({
        ...input,
        providerName: config.provider.name
      }),
    listSchedules: (query) => schedulerService.listSchedules(query),
    resolveContinuationSessionId: (taskId) => storage.tasks.findById(taskId)?.sessionId ?? null,
    pauseSchedule: (scheduleId) => schedulerService.pauseSchedule(scheduleId),
    resumeSchedule: (scheduleId) => schedulerService.resumeSchedule(scheduleId),
    runScheduleNow: (scheduleId) => schedulerService.runNow(scheduleId),
    updateSchedule: (scheduleId, patch) => schedulerService.updateSchedule(scheduleId, patch)
  });

  service = new AgentApplicationService({
    compact: config.compact,
    contextCompactor,
    customShell: config.workflow.customShell,
    databasePath: config.databasePath,
    executionKernel,
    findArtifact: (artifactId) => storage.artifacts.findById(artifactId),
    findLatestArtifactByType: (artifactType) => storage.artifacts.findLatestByType(artifactType),
    findMemory: (memoryId) => storage.memories.findById(memoryId),
    findExperience: (experienceId) => storage.experiences.findById(experienceId),
    listApprovals: (taskId) => storage.approvals.listByTaskId(taskId),
    listClarifyPrompts: (taskId) => storage.clarifyPrompts.listByTaskId(taskId),
    listArtifacts: (taskId) => storage.artifacts.listByTaskId(taskId),
    listAuditLogs: (taskId) => storage.auditLogs.listByTaskId(taskId),
    listMemories: () => storage.memories.list({ includeExpired: true, includeRejected: true }),
    listExperiences: () => storage.experiences.list(),
    listMemorySnapshots: (scope, scopeKey) => storage.memorySnapshots.listByScope(scope, scopeKey),
    listPendingApprovals: () => approvalService.listPending(),
    listPendingClarifyPrompts: () => clarifyService.listPending(),
    approvalRuleStore,
    approvalService,
    clarifyService,
    findTask: (taskId) => storage.tasks.findById(taskId),
    listTasks: () => storage.tasks.list(),
    findSession: (sessionId) => storage.sessions.findById(sessionId),
    findInboxItem: (inboxId) => storage.inbox.findById(inboxId),
    findSchedule: (scheduleId) => storage.schedules.findById(scheduleId),
    listSessions: () => storage.sessions.list(),
    listSchedules: (query) => storage.schedules.list(query),
    listScheduleRuns: (scheduleId, query) => storage.scheduleRuns.listByScheduleId(scheduleId, query),
    listScheduleRunsByTask: (taskId) => storage.scheduleRuns.listByTaskId(taskId),
    listScheduleRunsBySession: (sessionId) => storage.scheduleRuns.listBySessionId(sessionId),
    listInboxItems: (query) => storage.inbox.list(query),
    listSessionTasks: (sessionId) => storage.sessionTasks.listBySessionId(sessionId),
    listSessionSummaries: (sessionId) => storage.sessionSummaries.listBySession(sessionId),
    searchSessionSummaries: (input) =>
      input.sessionId !== undefined
        ? storage.sessionSummaries.search({
            limit: input.limit,
            query: input.query,
            sessionId: input.sessionId
          })
        : storage.sessionSummaries.searchGlobal({
            excludeSessionId: input.excludeSessionId ?? null,
            limit: input.limit,
            query: input.query
          }),
    findSessionSummary: (sessionSummaryId) => storage.sessionSummaries.findById(sessionSummaryId),
    listSessionLineage: (sessionId) => storage.sessionLineage.listBySessionId(sessionId),
    listToolCalls: (taskId) => storage.toolCalls.listByTaskId(taskId),
    listOutputEvents: (taskId) => storage.outputs.listByTaskId(taskId),
    listSessionOutputEvents: (sessionId) => storage.outputs.listBySessionId(sessionId),
    listTrace: (taskId) => storage.traces.listByTaskId(taskId),
    findExecutionCheckpoint: (taskId) => storage.checkpoints.findByTaskId(taskId),
    saveExecutionCheckpoint: (record) => storage.checkpoints.save(record),
    updateTask: (taskId, patch) => storage.tasks.update(taskId, patch),
    updateToolCall: (toolCallId, patch) => storage.toolCalls.update(toolCallId, patch),
    allowedFetchHosts: config.allowedFetchHosts,
    provider,
    providerCatalog: options.providerCatalog ?? resolveProviderCatalog(config.workspaceRoot),
    providerConfig: config.provider,
    providerRouter,
    auxiliaryProviderResolver,
    budgetService,
    runtimeConfigPath: config.runtimeConfigPath,
    runtimeConfigSource: config.runtimeConfigSource,
    runtimeVersion: config.runtimeVersion,
    scheduleRunLifecycle,
    schedulerService,
    resumePacketBuilder,
    sessionSummaryService,
    sessionService,
    sessionLineageRepository: storage.sessionLineage,
    sessionMessageRepository: storage.sessionMessages,
    sessionTranscriptRepository: storage.sessionTranscripts,
    shellBackend: config.workflow.shellBackend,
    tokenBudget: {
      inputLimit: config.tokenBudget.inputLimit,
      outputLimit: config.tokenBudget.outputLimit,
      reservedOutput: config.tokenBudget.reservedOutput,
      usedInput: config.tokenBudget.usedInput,
      usedOutput: config.tokenBudget.usedOutput,
      ...(config.tokenBudget.usedCostUsd !== undefined
        ? { usedCostUsd: config.tokenBudget.usedCostUsd }
        : {})
    },
    tokenBudgetInputLimitExplicit: config.tokenBudgetInputLimitExplicit,
    traceService,
    outputService,
    auditService,
    memoryPlane,
    manualCompactCoordinator,
    maxShellTimeoutMs: config.workflow.maxShellTimeoutMs,
    experiencePlane,
    skillDraftManager,
    skillRegistry,
    todoSessionStore,
    toolOverrideStore,
    toolRegistry,
    inboxService,
    commitmentService,
    nextActionService,
    sessionCommitmentProjector,
    testCommands: config.workflow.testCommands,
    assistantSessionProjectionService,
    sessionUiStateService,
    sessionIndexService,
    sessionMessageSearchService,
    sessionBranchService,
    sessionExecutionLock,
    sessionHandoffService,
    gatewaySessionRepository: storage.gatewaySessions,
    workspaceRoot: config.workspaceRoot,
    collectLegacyWorkspaceIssues: () =>
      collectLegacyWorkspaceIssues(config.workspaceRoot, storage.database),
    finalizeLegacyThreadSchema: () => finalizeLegacyThreadMigration(storage.database)
  });
  if (options.scheduler?.autoStart === true) {
    service.startScheduler();
  }

  return {
    close: () => {
      experienceCollector.stop();
      inboxCollector.stop();
      commitmentCollector.stop();
      promotionAdvisor.stop();
      budgetService.stop();
      service?.stopScheduler();
      void mcpClientManager.close();
      stopOutputTraceProjection();
      storage.close();
    },
    config,
    infrastructure: {
      approvalService,
      auditService,
      createRunOptions: (taskInput: string, cwdForRun: string) =>
        createDefaultRunOptions(taskInput, cwdForRun, config),
      mcpClientManager,
      skillRegistry,
      storage,
      sessionService,
      toolOrchestrator,
      traceService
    },
    service
  };
}

function backupDatabaseIfMigrationNeeded(workspaceRoot: string, databasePath: string): void {
  if (!existsSync(databasePath) || databasePath === ":memory:") {
    return;
  }

  const schemaVersion = readDatabaseSchemaVersion(databasePath);
  if (schemaVersion === null || schemaVersion >= RUNTIME_SCHEMA_VERSION) {
    return;
  }

  const rollbacksDir = join(workspaceRoot, ".auto-talon", "rollbacks");
  mkdirSync(rollbacksDir, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const backupPath = join(rollbacksDir, `db-backup-${timestamp}.sqlite`);
  copyFileSync(databasePath, backupPath);
}

function readDatabaseSchemaVersion(databasePath: string): number | null {
  try {
    const db = new DatabaseSync(databasePath);
    configureSqliteConnection(db);
    const row = db.prepare("PRAGMA user_version").get() as { user_version?: number };
    db.close();
    return row.user_version ?? 0;
  } catch {
    return null;
  }
}

interface SandboxConfigFile {
  defaultProfile?: string;
  profiles?: Record<string, Partial<SandboxProfile>>;
}

function assertScheduleToolsetsAvailable(
  scheduleToolsets: readonly ToolsetName[],
  toolOrchestrator: ToolOrchestrator
): void {
  if (scheduleToolsets.length === 0) {
    return;
  }
  const registeredToolsets = new Set(
    toolOrchestrator
      .listToolsWithMetadata()
      .map((tool) => resolveToolsetForTool(tool.name))
  );
  const unavailable = scheduleToolsets.filter((toolset) => !registeredToolsets.has(toolset));
  if (unavailable.length > 0) {
    throw new Error(`Scheduled run requested unavailable toolset(s): ${unavailable.join(", ")}`);
  }
}

function readDeliveryVerificationTargets(metadata: Record<string, unknown>): string[] {
  if (Array.isArray(metadata.deliveryTargets)) {
    return metadata.deliveryTargets.filter((target): target is string => typeof target === "string");
  }
  const delivery = metadata.delivery;
  if (typeof delivery === "object" && delivery !== null && !Array.isArray(delivery)) {
    const targets = (delivery as Record<string, unknown>).targets;
    if (Array.isArray(targets)) {
      return targets.filter((target): target is string => typeof target === "string");
    }
  }
  return ["inbox"];
}

function resolveSandboxProfile(
  workspaceRoot: string,
  options: ResolveAppConfigOptions
): SandboxProfile {
  const configPath = join(workspaceRoot, ".auto-talon", "sandbox.config.json");
  const fileConfig = loadSandboxConfigFile(configPath);
  const profileName =
    options.sandboxProfile ??
    process.env.AGENT_SANDBOX_PROFILE ??
    fileConfig.defaultProfile ??
    null;
  const fileProfile =
    profileName !== null && fileConfig.profiles !== undefined
      ? fileConfig.profiles[profileName]
      : undefined;
  const envWriteRoots = splitRootList(process.env.AGENT_WRITE_ROOTS);
  const cliWriteRoots = options.writeRoots ?? [];
  const mode =
    options.sandboxMode ??
    parseSandboxMode(process.env.AGENT_SANDBOX_MODE) ??
    fileProfile?.mode ??
    "local";
  const writeRoots = normalizeRootList([
    workspaceRoot,
    ...(fileProfile?.writeRoots ?? []),
    ...envWriteRoots,
    ...cliWriteRoots
  ]);

  return {
    configPath: existsSync(configPath) ? configPath : null,
    configSource:
      options.sandboxMode !== undefined || options.sandboxProfile !== undefined || cliWriteRoots.length > 0
        ? "cli"
        : process.env.AGENT_SANDBOX_MODE !== undefined ||
            process.env.AGENT_SANDBOX_PROFILE !== undefined ||
            process.env.AGENT_WRITE_ROOTS !== undefined ||
            process.env.AGENT_DOCKER_IMAGE !== undefined
          ? "env"
          : fileProfile !== undefined
            ? "file"
            : "defaults",
    dockerImage:
      process.env.AGENT_DOCKER_IMAGE ??
      fileProfile?.dockerImage ??
      null,
    mode,
    network: fileProfile?.network === "controlled" ? "controlled" : "disabled",
    profileName,
    readRoots: normalizeRootList([
      workspaceRoot,
      ...(fileProfile?.readRoots ?? []),
      ...writeRoots
    ]),
    shellAllowlist: fileProfile?.shellAllowlist ?? [],
    workspaceRoot,
    writeRoots
  };
}

function loadSandboxConfigFile(configPath: string): SandboxConfigFile {
  if (!existsSync(configPath)) {
    return {};
  }

  const content = readFileSync(configPath, "utf8").trim();
  if (content.length === 0) {
    return {};
  }

  try {
    return JSON.parse(content) as SandboxConfigFile;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse sandbox config ${configPath}: ${message}`);
  }
}

function splitRootList(value: string | undefined): string[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }

  return value
    .split(delimiter)
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeRootList(paths: string[]): string[] {
  return [...new Set(paths.map((entry) => resolve(entry)))];
}

function parseSandboxMode(value: string | undefined): SandboxMode | undefined {
  if (value === "local" || value === "docker") {
    return value;
  }

  return undefined;
}

export function createDefaultRunOptions(
  taskInput: string,
  cwd: string,
  config: AppConfig
): RuntimeRunOptions {
  return {
    agentProfileId: config.defaultProfileId,
    cwd,
    maxIterations: config.defaultMaxIterations,
    taskInput,
    timeoutMs: config.defaultTimeoutMs,
    tokenBudget: config.tokenBudget,
    userId: resolveDefaultUserId()
  };
}
