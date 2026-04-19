import { z } from "zod";

import type { ApprovalService } from "../approvals/approval-service";
import type { AuditService } from "../audit/audit-service";
import type { ProviderCatalogEntry, ResolvedProviderConfig } from "../providers";
import type {
  ApprovalRecord,
  ArtifactRecord,
  AuditLogRecord,
  MemoryRecord,
  MemoryScope,
  MemorySnapshotRecord,
  Provider,
  ProviderHealthCheck,
  ProviderStatsSnapshot,
  RuntimeRunOptions,
  TaskRecord,
  TraceEvent,
  ToolCallRecord
} from "../types";
import type { TraceService } from "../tracing/trace-service";
import type { MemoryPlane } from "../memory/memory-plane";
import type { ExecutionKernel } from "./execution-kernel";

import { AppError } from "./app-error";

export interface RunTaskResult {
  error?: AppError;
  output: string | null;
  task: TaskRecord;
}

export interface ApprovalActionResult {
  approval: ApprovalRecord;
  output: string | null;
  task: TaskRecord;
}

export interface AgentDoctorReport {
  apiKeyConfigured: boolean;
  configPath: string;
  configSource: "defaults" | "env" | "file";
  databasePath: string;
  endpointReachable: boolean | null;
  issues: string[];
  maxRetries: number;
  modelAvailable: boolean | null;
  modelConfigured: boolean;
  modelName: string | null;
  nodeVersion: string;
  providerHealthMessage: string;
  providerName: string;
  runtimeVersion: string;
  shell: string | undefined;
  timeoutMs: number;
  workspaceRoot: string;
}

export interface ContextTraceDebugReport {
  contextAssembly: Extract<TraceEvent, { eventType: "context_assembled" }>["payload"]["debugView"] | null;
  memoryRecall:
    | Extract<TraceEvent, { eventType: "memory_recalled" }>["payload"]
    | null;
  reviewerTrace:
    | Extract<TraceEvent, { eventType: "reviewer_trace" }>["payload"]
    | null;
  task: TaskRecord | null;
}

export interface RuntimeReadModel {
  findMemory(memoryId: string): MemoryRecord | null;
  findTask(taskId: string): TaskRecord | null;
  listApprovals(taskId: string): ApprovalRecord[];
  listArtifacts(taskId: string): ArtifactRecord[];
  listAuditLogs(taskId: string): AuditLogRecord[];
  listMemorySnapshots(scope: MemoryScope, scopeKey: string): MemorySnapshotRecord[];
  listPendingApprovals(): ApprovalRecord[];
  listMemories(): MemoryRecord[];
  listTasks(): TaskRecord[];
  listToolCalls(taskId: string): ToolCallRecord[];
  listTrace(taskId: string): TraceEvent[];
  updateToolCall(toolCallId: string, patch: Partial<ToolCallRecord>): ToolCallRecord;
}

export interface AgentApplicationServiceDependencies extends RuntimeReadModel {
  approvalService: ApprovalService;
  auditService: AuditService;
  databasePath: string;
  executionKernel: ExecutionKernel;
  memoryPlane: MemoryPlane;
  provider: Provider;
  providerCatalog: ProviderCatalogEntry[];
  providerConfig: ResolvedProviderConfig;
  runtimeVersion: string;
  traceService: TraceService;
  workspaceRoot: string;
}

const approvalActionSchema = z.object({
  action: z.enum(["allow", "deny"]),
  approvalId: z.string().min(1),
  reviewerId: z.string().min(1)
});

export class AgentApplicationService {
  public constructor(private readonly dependencies: AgentApplicationServiceDependencies) {}

  public async runTask(options: RuntimeRunOptions): Promise<RunTaskResult> {
    try {
      const result = await this.dependencies.executionKernel.run(options);
      return {
        output: result.output,
        task: result.task
      };
    } catch (error) {
      const appError =
        error instanceof AppError
          ? error
          : new AppError({
              code: "provider_error",
              message: error instanceof Error ? error.message : "Unknown runtime error"
            });

      const taskId =
        typeof appError.details?.taskId === "string" ? appError.details.taskId : null;
      const task = taskId === null ? null : this.dependencies.findTask(taskId);
      if (task === null) {
        throw appError;
      }

      return {
        error: appError,
        output: null,
        task
      };
    }
  }

  public listTasks(): TaskRecord[] {
    return this.dependencies.listTasks();
  }

  public listMemories(): MemoryRecord[] {
    return this.dependencies.listMemories();
  }

  public showMemoryScope(scope: MemoryScope, scopeKey: string): {
    memories: MemoryRecord[];
    snapshots: MemorySnapshotRecord[];
  } {
    return this.dependencies.memoryPlane.showScope(scope, scopeKey);
  }

  public createMemorySnapshot(
    scope: MemoryScope,
    scopeKey: string,
    label: string,
    createdBy: string
  ): MemorySnapshotRecord {
    return this.dependencies.memoryPlane.createSnapshot({
      createdBy,
      label,
      scope,
      scopeKey
    });
  }

  public reviewMemory(
    memoryId: string,
    status: "verified" | "rejected" | "stale",
    reviewerId: string,
    note: string
  ): MemoryRecord {
    return this.dependencies.memoryPlane.reviewMemory({
      memoryId,
      note,
      reviewerId,
      status
    });
  }

  public listPendingApprovals(): ApprovalRecord[] {
    this.reconcileExpiredApprovals();
    return this.dependencies.listPendingApprovals();
  }

  public async resolveApproval(
    approvalId: string,
    action: "allow" | "deny",
    reviewerId: string
  ): Promise<ApprovalActionResult> {
    this.reconcileExpiredApprovals();
    const parsed = approvalActionSchema.parse({
      action,
      approvalId,
      reviewerId
    });

    const approval = this.dependencies.approvalService.resolve(parsed);

    this.dependencies.traceService.record({
      actor: `reviewer.${reviewerId}`,
      eventType: "approval_resolved",
      payload: {
        approvalId: approval.approvalId,
        reviewerId: approval.reviewerId,
        status: approval.status,
        toolCallId: approval.toolCallId,
        toolName: approval.toolName
      },
      stage: "governance",
      summary: `Approval ${approval.status} for ${approval.toolName}`,
      taskId: approval.taskId
    });

    this.dependencies.auditService.record({
      action: "approval_resolved",
      actor: `reviewer.${reviewerId}`,
      approvalId: approval.approvalId,
      outcome:
        approval.status === "approved"
          ? "approved"
          : approval.status === "timed_out"
            ? "timed_out"
            : "denied",
      payload: {
        reviewerId,
        status: approval.status,
        toolName: approval.toolName
      },
      summary: `Approval ${approval.status} for ${approval.toolName}`,
      taskId: approval.taskId,
      toolCallId: approval.toolCallId
    });

    if (approval.status === "approved") {
      const result = await this.dependencies.executionKernel.resumeTask(approval.taskId);
      return {
        approval,
        output: result.output,
        task: result.task
      };
    }

    this.dependencies.updateToolCall(approval.toolCallId, {
      errorCode: approval.status === "timed_out" ? "approval_timeout" : "approval_denied",
      errorMessage:
        approval.status === "timed_out"
          ? `Approval ${approval.approvalId} timed out.`
          : `Approval ${approval.approvalId} was denied.`,
      finishedAt: new Date().toISOString(),
      status: approval.status === "timed_out" ? "timed_out" : "denied"
    });

    const failedTask = this.dependencies.executionKernel.failWaitingApprovalTask(
      approval.taskId,
      new AppError({
        code: approval.status === "timed_out" ? "approval_timeout" : "approval_denied",
        message:
          approval.status === "timed_out"
            ? `Approval ${approval.approvalId} timed out.`
            : `Approval ${approval.approvalId} was denied.`
      })
    );

    return {
      approval,
      output: null,
      task: failedTask
    };
  }

  public showTask(taskId: string): {
    approvals: ApprovalRecord[];
    artifacts: ArtifactRecord[];
    task: TaskRecord | null;
    toolCalls: ToolCallRecord[];
    trace: TraceEvent[];
  } {
    const task = this.dependencies.findTask(taskId);

    return {
      approvals: task === null ? [] : this.dependencies.listApprovals(taskId),
      artifacts: task === null ? [] : this.dependencies.listArtifacts(taskId),
      task,
      toolCalls: task === null ? [] : this.dependencies.listToolCalls(taskId),
      trace: task === null ? [] : this.dependencies.listTrace(taskId)
    };
  }

  public listArtifacts(taskId: string): ArtifactRecord[] {
    return this.dependencies.listArtifacts(taskId);
  }

  public listProviders(): ProviderCatalogEntry[] {
    return this.dependencies.providerCatalog;
  }

  public currentProvider(): ResolvedProviderConfig {
    return this.dependencies.providerConfig;
  }

  public providerStats(): ProviderStatsSnapshot | null {
    return this.dependencies.provider.getStats?.() ?? null;
  }

  public traceTask(taskId: string): TraceEvent[] {
    return this.dependencies.listTrace(taskId);
  }

  public subscribeToTaskTrace(taskId: string, listener: (event: TraceEvent) => void): () => void {
    return this.dependencies.traceService.subscribe((event) => {
      if (event.taskId === taskId) {
        listener(event);
      }
    });
  }

  public traceTaskContext(taskId: string): ContextTraceDebugReport {
    const task = this.dependencies.findTask(taskId);
    const trace = task === null ? [] : this.dependencies.listTrace(taskId);
    const contextAssembly = [...trace]
      .reverse()
      .find(
        (event): event is Extract<TraceEvent, { eventType: "context_assembled" }> =>
          event.eventType === "context_assembled"
      )?.payload.debugView ?? null;
    const memoryRecall = [...trace]
      .reverse()
      .find(
        (event): event is Extract<TraceEvent, { eventType: "memory_recalled" }> =>
          event.eventType === "memory_recalled"
      )?.payload ?? null;
    const reviewerTrace = [...trace]
      .reverse()
      .find(
        (event): event is Extract<TraceEvent, { eventType: "reviewer_trace" }> =>
          event.eventType === "reviewer_trace"
      )?.payload ?? null;

    return {
      contextAssembly,
      memoryRecall,
      reviewerTrace,
      task
    };
  }

  public auditTask(taskId: string): AuditLogRecord[] {
    return this.dependencies.listAuditLogs(taskId);
  }

  public async testCurrentProvider(signal?: AbortSignal): Promise<ProviderHealthCheck> {
    if (this.dependencies.provider.testConnection === undefined) {
      return {
        apiKeyConfigured: this.dependencies.providerConfig.apiKey !== null,
        endpointReachable: null,
        message: "Current provider does not expose a connection test.",
        modelAvailable: null,
        modelConfigured: this.dependencies.providerConfig.model !== null,
        modelName: this.dependencies.providerConfig.model,
        ok: false,
        providerName: this.dependencies.provider.name
      };
    }

    return this.dependencies.provider.testConnection(signal);
  }

  public async configDoctor(signal?: AbortSignal): Promise<AgentDoctorReport> {
    const providerHealth = await this.testCurrentProvider(signal);
    const issues = collectDoctorIssues(this.dependencies.providerConfig, providerHealth);

    return {
      apiKeyConfigured: providerHealth.apiKeyConfigured,
      configPath: this.dependencies.providerConfig.configPath,
      configSource: this.dependencies.providerConfig.configSource,
      databasePath: this.dependencies.databasePath,
      endpointReachable: providerHealth.endpointReachable,
      issues,
      maxRetries: this.dependencies.providerConfig.maxRetries,
      modelAvailable: providerHealth.modelAvailable,
      modelConfigured: providerHealth.modelConfigured,
      modelName: providerHealth.modelName,
      nodeVersion: process.version,
      providerHealthMessage: providerHealth.message,
      providerName: this.dependencies.provider.name,
      runtimeVersion: this.dependencies.runtimeVersion,
      shell: process.env.ComSpec,
      timeoutMs: this.dependencies.providerConfig.timeoutMs,
      workspaceRoot: this.dependencies.workspaceRoot
    };
  }

  private reconcileExpiredApprovals(): void {
    for (const approval of this.dependencies.approvalService.expirePending()) {
      this.dependencies.traceService.record({
        actor: "approval.service",
        eventType: "approval_resolved",
        payload: {
          approvalId: approval.approvalId,
          reviewerId: approval.reviewerId,
          status: approval.status,
          toolCallId: approval.toolCallId,
          toolName: approval.toolName
        },
        stage: "governance",
        summary: `Approval ${approval.status} for ${approval.toolName}`,
        taskId: approval.taskId
      });

      this.dependencies.auditService.record({
        action: "approval_resolved",
        actor: "approval.service",
        approvalId: approval.approvalId,
        outcome: "timed_out",
        payload: {
          status: approval.status,
          toolName: approval.toolName
        },
        summary: `Approval ${approval.status} for ${approval.toolName}`,
        taskId: approval.taskId,
        toolCallId: approval.toolCallId
      });

      this.dependencies.updateToolCall(approval.toolCallId, {
        errorCode: "approval_timeout",
        errorMessage: `Approval ${approval.approvalId} timed out.`,
        finishedAt: new Date().toISOString(),
        status: "timed_out"
      });

      this.dependencies.executionKernel.failWaitingApprovalTask(
        approval.taskId,
        new AppError({
          code: "approval_timeout",
          message: `Approval ${approval.approvalId} timed out.`
        })
      );
    }
  }
}

function collectDoctorIssues(
  providerConfig: ResolvedProviderConfig,
  providerHealth: ProviderHealthCheck
): string[] {
  const issues: string[] = [];

  if (!providerHealth.apiKeyConfigured && providerConfig.name !== "mock") {
    issues.push("API key is missing.");
  }

  if (!providerHealth.modelConfigured) {
    issues.push("Model is not configured.");
  }

  if (providerHealth.endpointReachable === false) {
    issues.push("Provider endpoint is not reachable.");
  }

  if (providerHealth.modelAvailable === false) {
    issues.push(`Model ${providerHealth.modelName ?? "-"} is not available on the provider endpoint.`);
  }

  return issues;
}
