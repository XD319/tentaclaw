import { z } from "zod";

import type { ApprovalService } from "../approvals/approval-service";
import type { AuditService } from "../audit/audit-service";
import type {
  ApprovalRecord,
  AuditLogRecord,
  MemoryRecord,
  MemoryScope,
  MemorySnapshotRecord,
  Provider,
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
  databasePath: string;
  nodeVersion: string;
  providerName: string;
  runtimeVersion: string;
  shell: string | undefined;
  workspaceRoot: string;
}

export interface RuntimeReadModel {
  findMemory(memoryId: string): MemoryRecord | null;
  findTask(taskId: string): TaskRecord | null;
  listApprovals(taskId: string): ApprovalRecord[];
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
    task: TaskRecord | null;
    toolCalls: ToolCallRecord[];
    trace: TraceEvent[];
  } {
    const task = this.dependencies.findTask(taskId);

    return {
      approvals: task === null ? [] : this.dependencies.listApprovals(taskId),
      task,
      toolCalls: task === null ? [] : this.dependencies.listToolCalls(taskId),
      trace: task === null ? [] : this.dependencies.listTrace(taskId)
    };
  }

  public traceTask(taskId: string): TraceEvent[] {
    return this.dependencies.listTrace(taskId);
  }

  public auditTask(taskId: string): AuditLogRecord[] {
    return this.dependencies.listAuditLogs(taskId);
  }

  public configDoctor(): AgentDoctorReport {
    return {
      databasePath: this.dependencies.databasePath,
      nodeVersion: process.version,
      providerName: this.dependencies.provider.name,
      runtimeVersion: this.dependencies.runtimeVersion,
      shell: process.env.ComSpec,
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
