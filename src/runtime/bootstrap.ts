import { join, resolve } from "node:path";

import { MockProvider } from "../agents/mock-provider";
import { ApprovalService } from "../approvals/approval-service";
import { AuditService } from "../audit/audit-service";
import { MemoryPlane } from "../memory/memory-plane";
import { ContextPolicy } from "../policy/context-policy";
import { DEFAULT_LOCAL_POLICY_CONFIG } from "../policy/default-policy-config";
import { PolicyEngine } from "../policy/policy-engine";
import { AgentProfileRegistry } from "../profiles/agent-profile-registry";
import { SandboxService } from "../sandbox/sandbox-service";
import { StorageManager } from "../storage/database";
import { TraceService } from "../tracing/trace-service";
import type { LocalPolicyConfig, Provider, RuntimeRunOptions, TokenBudget } from "../types";
import { FileReadTool, FileWriteTool, ShellTool, ToolOrchestrator, WebFetchTool } from "../tools";
import { ShellExecutor } from "../tools/shell/shell-executor";

import { AgentApplicationService } from "./application-service";
import { ExecutionKernel } from "./execution-kernel";

export interface AppConfig {
  approvalTtlMs: number;
  allowedFetchHosts: string[];
  databasePath: string;
  defaultMaxIterations: number;
  defaultProfileId: "executor" | "planner" | "reviewer";
  defaultTimeoutMs: number;
  runtimeVersion: string;
  tokenBudget: TokenBudget;
  workspaceRoot: string;
}

export function resolveAppConfig(cwd = process.cwd()): AppConfig {
  const workspaceRoot = resolve(process.env.AGENT_WORKSPACE_ROOT ?? cwd);

  return {
    approvalTtlMs: 5 * 60_000,
    allowedFetchHosts: ["example.com"],
    databasePath:
      process.env.AGENT_RUNTIME_DB_PATH ??
      join(workspaceRoot, ".tentaclaw", "agent-runtime.db"),
    defaultMaxIterations: 8,
    defaultProfileId: "executor",
    defaultTimeoutMs: 30_000,
    runtimeVersion: "phase3",
    tokenBudget: {
      inputLimit: 8_000,
      outputLimit: 2_000,
      reservedOutput: 500,
      usedInput: 0,
      usedOutput: 0
    },
    workspaceRoot
  };
}

export interface AppRuntimeHandle {
  close: () => void;
  config: AppConfig;
  service: AgentApplicationService;
}

export interface CreateApplicationOptions {
  config?: Partial<AppConfig>;
  policyConfig?: LocalPolicyConfig;
  provider?: Provider;
}

export function createApplication(
  cwd = process.cwd(),
  options: CreateApplicationOptions = {}
): AppRuntimeHandle {
  const config = {
    ...resolveAppConfig(cwd),
    ...options.config
  };

  const storage = new StorageManager({
    databasePath: config.databasePath
  });
  const traceService = new TraceService(storage.traces);
  const auditService = new AuditService(storage.auditLogs);
  const approvalService = new ApprovalService(storage.approvals, {
    approvalTtlMs: config.approvalTtlMs
  });
  const contextPolicy = new ContextPolicy();
  const policyEngine = new PolicyEngine(options.policyConfig ?? DEFAULT_LOCAL_POLICY_CONFIG);
  const agentProfileRegistry = new AgentProfileRegistry();
  const provider = options.provider ?? new MockProvider();
  const sandboxService = new SandboxService({
    allowedEnvKeys: ["CI", "FORCE_COLOR", "NODE_ENV", "NO_COLOR"],
    allowedFetchHosts: config.allowedFetchHosts,
    maxShellTimeoutMs: 30_000,
    workspaceRoot: config.workspaceRoot
  });
  const toolOrchestrator = new ToolOrchestrator({
    approvalService,
    artifactRepository: storage.artifacts,
    auditService,
    contextPolicy,
    policyEngine,
    toolCallRepository: storage.toolCalls,
    tools: [
      new FileReadTool(sandboxService),
      new FileWriteTool(sandboxService),
      new ShellTool(new ShellExecutor(), sandboxService),
      new WebFetchTool(sandboxService)
    ],
    traceService
  });
  const memoryPlane = new MemoryPlane({
    contextPolicy,
    memoryRepository: storage.memories,
    memorySnapshotRepository: storage.memorySnapshots,
    traceService
  });

  const executionKernel = new ExecutionKernel({
    agentProfileRegistry,
    executionCheckpointRepository: storage.checkpoints,
    memoryPlane,
    provider,
    runMetadataRepository: storage.runMetadata,
    runtimeVersion: config.runtimeVersion,
    taskRepository: storage.tasks,
    toolOrchestrator,
    traceService,
    workspaceRoot: config.workspaceRoot
  });

  return {
    close: () => storage.close(),
    config,
    service: new AgentApplicationService({
      databasePath: config.databasePath,
      executionKernel,
      findMemory: (memoryId) => storage.memories.findById(memoryId),
      listApprovals: (taskId) => storage.approvals.listByTaskId(taskId),
      listArtifacts: (taskId) => storage.artifacts.listByTaskId(taskId),
      listAuditLogs: (taskId) => storage.auditLogs.listByTaskId(taskId),
      listMemories: () => storage.memories.list({ includeExpired: true, includeRejected: true }),
      listMemorySnapshots: (scope, scopeKey) => storage.memorySnapshots.listByScope(scope, scopeKey),
      listPendingApprovals: () => approvalService.listPending(),
      approvalService,
      findTask: (taskId) => storage.tasks.findById(taskId),
      listTasks: () => storage.tasks.list(),
      listToolCalls: (taskId) => storage.toolCalls.listByTaskId(taskId),
      listTrace: (taskId) => storage.traces.listByTaskId(taskId),
      updateToolCall: (toolCallId, patch) => storage.toolCalls.update(toolCallId, patch),
      provider,
      runtimeVersion: config.runtimeVersion,
      traceService,
      auditService,
      memoryPlane,
      workspaceRoot: config.workspaceRoot
    })
  };
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
    userId: process.env.USERNAME ?? process.env.USER ?? "local-user"
  };
}
