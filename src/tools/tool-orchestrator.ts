import { randomUUID } from "node:crypto";
import { z } from "zod";

import { AppError, toAppError } from "../runtime/app-error";
import { safePreview } from "../runtime/serialization";
import type { TraceService } from "../tracing/trace-service";
import type {
  ArtifactRepository,
  ProviderToolDescriptor,
  ToolCallRecord,
  ToolCallRepository,
  ToolCallRequest,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionSuccess
} from "../types";

export interface ToolOrchestratorDependencies {
  artifactRepository: ArtifactRepository;
  toolCallRepository: ToolCallRepository;
  traceService: TraceService;
  tools: ToolDefinition[];
}

export interface ToolExecutionOutcome {
  result: ToolExecutionSuccess;
  toolCall: ToolCallRecord;
}

export class ToolOrchestrator {
  private readonly tools = new Map<string, ToolDefinition>();

  public constructor(private readonly dependencies: ToolOrchestratorDependencies) {
    for (const tool of dependencies.tools) {
      this.tools.set(tool.name, tool);
    }
  }

  public listTools(): ProviderToolDescriptor[] {
    return [...this.tools.values()].map((tool) => ({
      description: tool.description,
      inputSchema: tool.inputSchemaDescriptor,
      name: tool.name,
      riskLevel: tool.riskLevel
    }));
  }

  public async execute(
    request: ToolCallRequest,
    context: ToolExecutionContext
  ): Promise<ToolExecutionOutcome> {
    const tool = this.tools.get(request.toolName);
    const riskLevel = tool?.riskLevel ?? "high";
    const requestedAt = new Date().toISOString();

    let toolCall = this.dependencies.toolCallRepository.create({
      errorCode: null,
      errorMessage: null,
      finishedAt: null,
      input: request.input,
      iteration: request.iteration,
      output: null,
      requestedAt,
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

    if (tool === undefined) {
      return this.failToolCall(
        toolCall,
        new AppError({
          code: "tool_not_found",
          message: `Tool ${request.toolName} is not registered.`
        })
      );
    }

    const parsed = tool.inputSchema.safeParse(request.input);
    if (!parsed.success) {
      return this.failToolCall(
        toolCall,
        new AppError({
          code: "tool_validation_error",
          details: {
            issues: z.treeifyError(parsed.error)
          },
          message: parsed.error.message
        })
      );
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
      const result = await tool.execute(parsed.data, context);
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

      const finishedCall = this.dependencies.toolCallRepository.update(toolCall.toolCallId, {
        finishedAt: new Date().toISOString(),
        output: result.output,
        status: "finished",
        summary: result.summary
      });

      this.dependencies.traceService.record({
        actor: `tool.${tool.name}`,
        eventType: "tool_call_finished",
        payload: {
          iteration: request.iteration,
          outputPreview: safePreview(result.output),
          summary: result.summary,
          toolCallId: finishedCall.toolCallId,
          toolName: tool.name
        },
        stage: "tooling",
        summary: `Tool ${tool.name} finished`,
        taskId: request.taskId
      });

      return {
        result,
        toolCall: finishedCall
      };
    } catch (error) {
      return this.failToolCall(toolCall, toAppError(error));
    }
  }

  private failToolCall(
    toolCall: ToolCallRecord,
    error: AppError
  ): never {
    const failedCall = this.dependencies.toolCallRepository.update(toolCall.toolCallId, {
      errorCode: error.code,
      errorMessage: error.message,
      finishedAt: new Date().toISOString(),
      status: "failed"
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

    throw error;
  }
}
