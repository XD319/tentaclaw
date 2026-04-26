import { randomUUID } from "node:crypto";
import { z } from "zod";

import { AppError, toAppError } from "../runtime/app-error.js";
import { safePreview } from "../runtime/serialization.js";
import type { ApprovalService } from "../approvals/approval-service.js";
import type { AuditService } from "../audit/audit-service.js";
import type { ContextPolicy } from "../policy/context-policy.js";
import type { PolicyEngine } from "../policy/policy-engine.js";
import type { TraceService } from "../tracing/trace-service.js";
import type {
  ApprovalRecord,
  ArtifactRepository,
  JsonObject,
  ProviderToolDescriptor,
  SandboxExecutionPlan,
  ToolCallRecord,
  ToolCallRepository,
  ToolCallRequest,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionSuccess
} from "../types/index.js";

export interface ToolOrchestratorDependencies {
  approvalService: ApprovalService;
  artifactRepository: ArtifactRepository;
  auditService: AuditService;
  contextPolicy: ContextPolicy;
  policyEngine: PolicyEngine;
  toolCallRepository: ToolCallRepository;
  traceService: TraceService;
  tools: ToolDefinition[];
}

export interface ToolExecutionCompletedOutcome {
  kind: "completed";
  result: ToolExecutionSuccess;
  toolCall: ToolCallRecord;
}

export interface ToolExecutionApprovalRequiredOutcome {
  approval: ApprovalRecord;
  kind: "approval_required";
  toolCall: ToolCallRecord;
}

export type ToolExecutionOutcome =
  | ToolExecutionCompletedOutcome
  | ToolExecutionApprovalRequiredOutcome;

export class ToolOrchestrator {
  private readonly tools = new Map<string, ToolDefinition>();

  public constructor(private readonly dependencies: ToolOrchestratorDependencies) {
    for (const tool of dependencies.tools) {
      this.tools.set(tool.name, tool);
    }
  }

  public listTools(allowedToolNames?: string[]): ProviderToolDescriptor[] {
    return [...this.tools.values()]
      .filter((tool) => allowedToolNames === undefined || allowedToolNames.includes(tool.name))
      .map((tool) => ({
        capability: tool.capability,
        description: tool.description,
        inputSchema: tool.inputSchemaDescriptor,
        name: tool.name,
        privacyLevel: tool.privacyLevel,
        riskLevel: tool.riskLevel
      }));
  }

  public listToolsWithMetadata(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  public describeTool(toolName: string): ProviderToolDescriptor | null {
    const tool = this.tools.get(toolName);
    if (tool === undefined) {
      return null;
    }

    return {
      capability: tool.capability,
      description: tool.description,
      inputSchema: tool.inputSchemaDescriptor,
      name: tool.name,
      privacyLevel: tool.privacyLevel,
      riskLevel: tool.riskLevel
    };
  }

  public async execute(
    request: ToolCallRequest,
    context: ToolExecutionContext
  ): Promise<ToolExecutionOutcome> {
    const tool = this.tools.get(request.toolName);
    const riskLevel = tool?.riskLevel ?? "high";
    let toolCall = this.ensureToolCallRecord(request, riskLevel);

    if (tool === undefined) {
      return this.failToolCall(
        toolCall,
        new AppError({
          code: "tool_not_found",
          message: `Tool ${request.toolName} is not registered.`
        })
      );
    }

    const replayOutcome = this.replayTerminalOutcome(toolCall);
    if (replayOutcome !== null) {
      const replayedSummary =
        toolCall.summary ?? `Tool ${tool.name} finished (replayed).`;
      this.dependencies.traceService.record({
        actor: `tool.${tool.name}`,
        eventType: "tool_call_finished",
        payload: {
          iteration: request.iteration,
          outputPreview: safePreview(toolCall.output),
          replayed: true,
          status: toolCall.status,
          summary: replayedSummary,
          toolCallId: toolCall.toolCallId,
          toolName: tool.name
        },
        stage: "tooling",
        summary: `Tool ${tool.name} replayed from persisted terminal status`,
        taskId: request.taskId
      });
      return replayOutcome;
    }

    if (tool.checkAvailability !== undefined) {
      const availability = await tool.checkAvailability(context);
      if (!availability.available) {
        return this.failToolCall(
          toolCall,
          new AppError({
            code: "tool_unavailable",
            details: {
              reason: availability.reason
            },
            message: `Tool ${tool.name} is unavailable: ${availability.reason}`
          })
        );
      }
    }

    const parsed = tool.inputSchema.safeParse(request.input);
    if (!parsed.success) {
      const validationSummary = summarizeValidationIssues(parsed.error.issues);
      return this.failToolCall(
        toolCall,
        new AppError({
          code: "tool_validation_error",
          details: {
            issues: z.treeifyError(parsed.error)
          },
          message: validationSummary
        })
      );
    }

    let prepared: Awaited<ReturnType<typeof tool.prepare>>;
    try {
      prepared = await tool.prepare(parsed.data, context);
      this.recordSandboxEvent(request, tool.name, prepared.sandbox, "allowed");
    } catch (error) {
      const appError = toAppError(error);
      this.recordSandboxFailure(request, tool.name, appError);
      return this.failToolCall(toolCall, appError);
    }

    const policyDecision = this.dependencies.policyEngine.evaluate({
      agentProfileId: context.agentProfileId,
      capability: tool.capability,
      metadata: {
        sandboxKind: prepared.sandbox.kind,
        summary: prepared.governance.summary
      },
      pathScope: prepared.governance.pathScope,
      privacyLevel: tool.privacyLevel,
      riskLevel: tool.riskLevel,
      taskId: request.taskId,
      toolCallId: toolCall.toolCallId,
      toolName: tool.name,
      userId: context.userId,
      workspaceRoot: context.workspaceRoot
    });

    this.dependencies.traceService.record({
      actor: "policy.engine",
      eventType: "policy_decision",
      payload: {
        capability: tool.capability,
        decisionId: policyDecision.decisionId,
        effect: policyDecision.effect,
        matchedRuleId: policyDecision.matchedRuleId,
        pathScope: prepared.governance.pathScope,
        privacyLevel: tool.privacyLevel,
        riskLevel: tool.riskLevel,
        toolCallId: toolCall.toolCallId,
        toolName: tool.name
      },
      stage: "governance",
      summary: policyDecision.reason,
      taskId: request.taskId
    });

    this.dependencies.auditService.record({
      action: "policy_decision",
      actor: "policy.engine",
      approvalId: null,
      outcome:
        policyDecision.effect === "deny"
          ? "denied"
          : policyDecision.effect === "allow_with_approval"
            ? "pending"
            : "approved",
      payload: {
        capability: tool.capability,
        decisionId: policyDecision.decisionId,
        effect: policyDecision.effect,
        matchedRuleId: policyDecision.matchedRuleId,
        pathScope: prepared.governance.pathScope,
        privacyLevel: tool.privacyLevel,
        riskLevel: tool.riskLevel,
        toolName: tool.name
      },
      summary: policyDecision.reason,
      taskId: request.taskId,
      toolCallId: toolCall.toolCallId
    });

    if (policyDecision.effect === "deny") {
      return this.failToolCall(
        toolCall,
        new AppError({
          code: "policy_denied",
          details: {
            decisionId: policyDecision.decisionId
          },
          message: policyDecision.reason
        })
      );
    }

    if (policyDecision.effect === "allow_with_approval") {
      const approvalRequest = this.dependencies.approvalService.ensureApprovalRequest({
        policyDecisionId: policyDecision.decisionId,
        reason: formatApprovalReason(request.reason, prepared.sandbox),
        requesterUserId: context.userId,
        taskId: request.taskId,
        toolCallId: toolCall.toolCallId,
        toolName: tool.name
      });

      const approval = approvalRequest.approval;
      if (approval.status === "pending") {
        toolCall = this.dependencies.toolCallRepository.update(toolCall.toolCallId, {
          status: toolCall.status === "approved" ? "approved" : "awaiting_approval"
        });

        if (approvalRequest.created) {
          this.dependencies.traceService.record({
            actor: "approval.service",
            eventType: "approval_requested",
            payload: {
              approvalId: approval.approvalId,
              expiresAt: approval.expiresAt,
              toolCallId: toolCall.toolCallId,
              toolName: tool.name
            },
            stage: "governance",
            summary: `Approval requested for ${tool.name}`,
            taskId: request.taskId
          });

          this.dependencies.auditService.record({
            action: "approval_requested",
            actor: "approval.service",
            approvalId: approval.approvalId,
            outcome: "pending",
            payload: {
              expiresAt: approval.expiresAt,
              reason: approval.reason,
              toolName: approval.toolName
            },
            summary: `Approval requested for ${tool.name}`,
            taskId: request.taskId,
            toolCallId: toolCall.toolCallId
          });
        }

        return {
          approval,
          kind: "approval_required",
          toolCall
        };
      }

      if (approval.status === "denied") {
        return this.failToolCall(
          toolCall,
          new AppError({
            code: "approval_denied",
            details: {
              approvalId: approval.approvalId
            },
            message: `Approval ${approval.approvalId} was denied for ${tool.name}.`
          }),
          "denied"
        );
      }

      if (approval.status === "timed_out") {
        return this.failToolCall(
          toolCall,
          new AppError({
            code: "approval_timeout",
            details: {
              approvalId: approval.approvalId
            },
            message: `Approval ${approval.approvalId} timed out for ${tool.name}.`
          }),
          "timed_out"
        );
      }

      toolCall = this.dependencies.toolCallRepository.update(toolCall.toolCallId, {
        status: "approved"
      });
    }

    toolCall = this.dependencies.toolCallRepository.update(toolCall.toolCallId, {
      startedAt: new Date().toISOString(),
      status: "started"
    });

    this.dependencies.traceService.record({
      actor: `tool.${tool.name}`,
      eventType: "tool_call_started",
      payload: {
        iteration: request.iteration,
        toolCallId: toolCall.toolCallId,
        toolName: tool.name
      },
      stage: "tooling",
      summary: `Tool ${tool.name} started`,
      taskId: request.taskId
    });

    try {
      const result = await tool.execute(prepared.preparedInput, context);
      if (!result.success) {
        return this.failToolCall(
          toolCall,
          result.details === undefined
            ? new AppError({
                code: result.errorCode,
                message: result.errorMessage
              })
            : new AppError({
                code: result.errorCode,
                details: result.details,
                message: result.errorMessage
              })
        );
      }

      this.dependencies.artifactRepository.createMany(
        request.taskId,
        toolCall.toolCallId,
        result.artifacts ?? []
      );

      const persistedOutput = sanitizePersistedOutput(
        result.output,
        tool.privacyLevel,
        this.dependencies.contextPolicy
      );
      const finishedCall = this.dependencies.toolCallRepository.update(toolCall.toolCallId, {
        finishedAt: new Date().toISOString(),
        output: persistedOutput,
        status: "finished",
        summary: result.summary
      });

      this.dependencies.traceService.record({
        actor: `tool.${tool.name}`,
        eventType: "tool_call_finished",
        payload: {
          iteration: request.iteration,
          outputPreview: safePreview(persistedOutput),
          summary: result.summary,
          toolCallId: finishedCall.toolCallId,
          toolName: tool.name
        },
        stage: "tooling",
        summary: `Tool ${tool.name} finished`,
        taskId: request.taskId
      });

      this.recordToolAudit(tool, request, finishedCall, "succeeded", result);

      return {
        kind: "completed",
        result,
        toolCall: finishedCall
      };
    } catch (error) {
      return this.failToolCall(toolCall, toAppError(error));
    }
  }

  private ensureToolCallRecord(
    request: ToolCallRequest,
    riskLevel: ToolCallRecord["riskLevel"]
  ): ToolCallRecord {
    const existing = this.dependencies.toolCallRepository.findById(request.toolCallId);
    if (existing !== null) {
      return existing;
    }

    const toolCall = this.dependencies.toolCallRepository.create({
      errorCode: null,
      errorMessage: null,
      finishedAt: null,
      input: request.input,
      iteration: request.iteration,
      output: null,
      requestedAt: new Date().toISOString(),
      riskLevel,
      startedAt: null,
      status: "requested",
      summary: null,
      taskId: request.taskId,
      toolCallId: request.toolCallId || randomUUID(),
      toolName: request.toolName
    });

    this.dependencies.traceService.record({
      actor: "runtime.orchestrator",
      eventType: "tool_call_requested",
      payload: {
        input: request.input,
        iteration: request.iteration,
        reason: request.reason,
        riskLevel,
        toolCallId: toolCall.toolCallId,
        toolName: request.toolName
      },
      stage: "tooling",
      summary: `Tool ${request.toolName} requested`,
      taskId: request.taskId
    });

    if (riskLevel === "high") {
      this.dependencies.auditService.record({
        action: "high_risk_tool_requested",
        actor: "runtime.orchestrator",
        approvalId: null,
        outcome: "attempted",
        payload: {
          input: request.input,
          reason: request.reason,
          riskLevel,
          toolName: request.toolName
        },
        summary: `High-risk tool ${request.toolName} requested`,
        taskId: request.taskId,
        toolCallId: toolCall.toolCallId
      });
    }

    return toolCall;
  }

  private recordSandboxEvent(
    request: ToolCallRequest,
    toolName: string,
    sandboxPlan: SandboxExecutionPlan,
    status: "allowed" | "denied"
  ): void {
    const target = getSandboxTarget(sandboxPlan);
    this.dependencies.traceService.record({
      actor: "sandbox.service",
      eventType: "sandbox_enforced",
      payload: {
        sandboxKind: sandboxPlan.kind,
        status,
        target,
        toolCallId: request.toolCallId,
        toolName
      },
      stage: "governance",
      summary: `Sandbox ${status} for ${toolName}`,
      taskId: request.taskId
    });

    this.dependencies.auditService.record({
      action: "sandbox_enforced",
      actor: "sandbox.service",
      approvalId: null,
      outcome: status === "allowed" ? "approved" : "denied",
      payload: {
        sandbox: sandboxPlan,
        target,
        toolName
      },
      summary: `Sandbox ${status} for ${toolName}`,
      taskId: request.taskId,
      toolCallId: request.toolCallId
    });
  }

  private recordSandboxFailure(
    request: ToolCallRequest,
    toolName: string,
    error: AppError
  ): void {
    const sandboxDetails =
      typeof error.details?.sandbox === "object" && error.details?.sandbox !== null
        ? (error.details.sandbox as Record<string, unknown>)
        : null;

    if (sandboxDetails === null) {
      return;
    }

    const sandboxKind = extractSandboxKind(sandboxDetails);
    const target = extractSandboxTarget(sandboxDetails);
    this.dependencies.traceService.record({
      actor: "sandbox.service",
      eventType: "sandbox_enforced",
      payload: {
        sandboxKind,
        status: "denied",
        target,
        toolCallId: request.toolCallId,
        toolName
      },
      stage: "governance",
      summary: error.message,
      taskId: request.taskId
    });

    this.dependencies.auditService.record({
      action: "sandbox_enforced",
      actor: "sandbox.service",
      approvalId: null,
      outcome: "denied",
      payload: {
        sandbox: sandboxDetails as JsonObject,
        toolName
      },
      summary: error.message,
      taskId: request.taskId,
      toolCallId: request.toolCallId
    });
  }

  private recordToolAudit(
    tool: ToolDefinition,
    request: ToolCallRequest,
    toolCall: ToolCallRecord,
    outcome: "succeeded" | "failed",
    result: ToolExecutionSuccess
  ): void {
    const action =
      tool.capability === "filesystem.write"
        ? "file_write"
        : tool.capability === "shell.execute"
          ? "shell_execution"
          : tool.capability === "network.fetch_public_readonly"
            ? "web_fetch"
            : null;

    if (action === null) {
      return;
    }

    this.dependencies.auditService.record({
      action,
      actor: `tool.${tool.name}`,
      approvalId: null,
      outcome,
      payload: {
        outputPreview: safePreview(result.output),
        summary: result.summary
      },
      summary: result.summary,
      taskId: request.taskId,
      toolCallId: toolCall.toolCallId
    });
  }

  private failToolCall(
    toolCall: ToolCallRecord,
    error: AppError,
    status: ToolCallRecord["status"] = "failed"
  ): never {
    const failedCall = this.dependencies.toolCallRepository.update(toolCall.toolCallId, {
      errorCode: error.code,
      errorMessage: error.message,
      finishedAt: new Date().toISOString(),
      status
    });

    this.dependencies.traceService.record({
      actor: `tool.${failedCall.toolName}`,
      eventType: "tool_call_failed",
      payload: {
        errorCode: error.code,
        errorMessage: error.message,
        iteration: failedCall.iteration,
        toolCallId: failedCall.toolCallId,
        toolName: failedCall.toolName
      },
      stage: "tooling",
      summary: `Tool ${failedCall.toolName} failed`,
      taskId: failedCall.taskId
    });

    this.dependencies.auditService.record({
      action: status === "denied" || status === "timed_out" ? "tool_rejected" : "tool_failure",
      actor: `tool.${failedCall.toolName}`,
      approvalId: null,
      outcome:
        status === "denied"
          ? "denied"
          : status === "timed_out"
            ? "timed_out"
            : "failed",
      payload: {
        errorCode: error.code,
        errorMessage: error.message,
        status
      },
      summary: error.message,
      taskId: failedCall.taskId,
      toolCallId: failedCall.toolCallId
    });

    throw error;
  }

  private replayTerminalOutcome(toolCall: ToolCallRecord): ToolExecutionCompletedOutcome | null {
    if (toolCall.status === "failed") {
      throw new AppError({
        code: toolCall.errorCode ?? "tool_execution_error",
        message:
          toolCall.errorMessage ??
          `Tool ${toolCall.toolName} previously failed (replayed).`
      });
    }

    if (toolCall.status !== "finished") {
      return null;
    }

    return {
      kind: "completed",
      result: {
        output: toolCall.output,
        success: true,
        summary: toolCall.summary ?? `Tool ${toolCall.toolName} finished (replayed).`
      },
      toolCall
    };
  }
}

function summarizeValidationIssues(issues: z.ZodIssue[]): string {
  if (issues.length === 0) {
    return "Tool input validation failed.";
  }

  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    })
    .join(" | ");
}

function formatApprovalReason(reason: string, sandboxPlan: SandboxExecutionPlan): string {
  if (sandboxPlan.kind !== "file") {
    return reason;
  }

  return [
    reason,
    `Resolved path: ${sandboxPlan.resolvedPath}`,
    `Operation: ${sandboxPlan.operation}`,
    `Path scope: ${sandboxPlan.pathScope}`,
    `Extra write root: ${sandboxPlan.withinExtraWriteRoot === true ? "yes" : "no"}`
  ].join("\n");
}

function getSandboxTarget(sandboxPlan: SandboxExecutionPlan): string {
  switch (sandboxPlan.kind) {
    case "file":
      return sandboxPlan.resolvedPath;
    case "network":
      return sandboxPlan.url;
    case "shell":
      return sandboxPlan.cwd;
    case "mcp":
      return sandboxPlan.target;
    default:
      return "unknown";
  }
}

function extractSandboxKind(sandboxDetails: Record<string, unknown>): "file" | "network" | "shell" | "mcp" {
  const kind = sandboxDetails.kind;
  return kind === "file" || kind === "network" || kind === "shell" || kind === "mcp"
    ? kind
    : "shell";
}

function extractSandboxTarget(sandboxDetails: Record<string, unknown>): string {
  if (typeof sandboxDetails.resolvedPath === "string") {
    return sandboxDetails.resolvedPath;
  }

  if (typeof sandboxDetails.url === "string") {
    return sandboxDetails.url;
  }

  if (typeof sandboxDetails.cwd === "string") {
    return sandboxDetails.cwd;
  }

  if (typeof sandboxDetails.target === "string") {
    return sandboxDetails.target;
  }

  return "unknown";
}

function sanitizePersistedOutput(
  value: ToolExecutionSuccess["output"],
  privacyLevel: ToolDefinition["privacyLevel"],
  contextPolicy: ContextPolicy
): ToolExecutionSuccess["output"] {
  if (privacyLevel !== "restricted") {
    return value;
  }

  if (typeof value === "string") {
    return contextPolicy.redactText(value, privacyLevel);
  }

  return {
    redacted: contextPolicy.redactText(JSON.stringify(value), privacyLevel)
  };
}
