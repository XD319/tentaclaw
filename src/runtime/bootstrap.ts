import { join, resolve } from "node:path";

import { MockProvider } from "../agents/mock-provider";
import { MemoryPlane } from "../memory/memory-plane";
import { PathPolicy } from "../policy/path-policy";
import { ShellPolicy } from "../policy/shell-policy";
import { StorageManager } from "../storage/database";
import { TraceService } from "../tracing/trace-service";
import type { Provider, RuntimeRunOptions, TokenBudget } from "../types";
import { FileReadTool, FileWriteTool, ShellTool, ToolOrchestrator } from "../tools";
import { ShellExecutor } from "../tools/shell/shell-executor";

import { AgentApplicationService } from "./application-service";
import { ExecutionKernel } from "./execution-kernel";

export interface AppConfig {
  databasePath: string;
  defaultMaxIterations: number;
  defaultTimeoutMs: number;
  runtimeVersion: string;
  tokenBudget: TokenBudget;
  workspaceRoot: string;
}

export function resolveAppConfig(cwd = process.cwd()): AppConfig {
  const workspaceRoot = resolve(process.env.AGENT_WORKSPACE_ROOT ?? cwd);

  return {
    databasePath:
      process.env.AGENT_RUNTIME_DB_PATH ??
      join(workspaceRoot, ".tentaclaw", "agent-runtime.db"),
    defaultMaxIterations: 8,
    defaultTimeoutMs: 30_000,
    runtimeVersion: "phase1",
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
  const provider = options.provider ?? new MockProvider();
  const pathPolicy = new PathPolicy({
    workspaceRoot: config.workspaceRoot
  });
  const shellPolicy = new ShellPolicy({
    allowedEnvKeys: ["CI", "FORCE_COLOR", "NODE_ENV", "NO_COLOR"],
    maxTimeoutMs: 30_000
  });
  const toolOrchestrator = new ToolOrchestrator({
    artifactRepository: storage.artifacts,
    toolCallRepository: storage.toolCalls,
    tools: [
      new FileReadTool(pathPolicy),
      new FileWriteTool(pathPolicy),
      new ShellTool(new ShellExecutor(), shellPolicy, pathPolicy)
    ],
    traceService
  });

  const executionKernel = new ExecutionKernel({
    memoryPlane: new MemoryPlane(),
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
      findTask: (taskId) => storage.tasks.findById(taskId),
      listTasks: () => storage.tasks.list(),
      listToolCalls: (taskId) => storage.toolCalls.listByTaskId(taskId),
      listTrace: (taskId) => storage.traces.listByTaskId(taskId),
      provider,
      runtimeVersion: config.runtimeVersion,
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
    cwd,
    maxIterations: config.defaultMaxIterations,
    taskInput,
    timeoutMs: config.defaultTimeoutMs,
    tokenBudget: config.tokenBudget
  };
}
