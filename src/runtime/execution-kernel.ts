import { randomUUID } from "node:crypto";

import { createManagedAbortController, throwIfAborted } from "./abort-controller";
import { AppError, toAppError } from "./app-error";
import {
  buildFilteredContextDebugFragments,
  ExecutionContextAssembler
} from "./context-assembler";
import { buildRepoMap } from "./repo-map";
import { tokenBudgetToJson } from "./serialization";
import type { RuntimeConfig, WorkflowRuntimeConfig } from "./runtime-config";
import { ProviderError } from "../providers";
import type { AgentProfileRegistry } from "../profiles/agent-profile-registry";
import type {
  ConversationMessage,
  ContextAssemblyDebugView,
  ContextFragment,
  ExecutionCheckpointRepository,
  MemoryRecallResult,
  Provider,
  ProviderToolCall,
  RuntimeTaskEvent,
  RunMetadataRepository,
  RuntimeRunOptions,
  RuntimeRunResult,
  TaskRecord,
  TaskRepository,
  TokenBudget
} from "../types";
import type { MemoryPlane } from "../memory/memory-plane";
import { buildCapabilityDeclaration } from "../memory/capability-declaration-builder";
import type { SkillContextService } from "../skills";
import type { ToolOrchestrator } from "../tools";
import type { TraceService } from "../tracing/trace-service";

export interface ExecutionKernelDependencies {
  agentProfileRegistry: AgentProfileRegistry;
  executionCheckpointRepository: ExecutionCheckpointRepository;
  memoryPlane: MemoryPlane;
  provider: Provider;
  runMetadataRepository: RunMetadataRepository;
  runtimeVersion: string;
  skillContextService: SkillContextService;
  taskRepository: TaskRepository;
  toolOrchestrator: ToolOrchestrator;
  traceService: TraceService;
  workflow: WorkflowRuntimeConfig;
  compact: RuntimeConfig["compact"];
  workspaceRoot: string;
}

interface ExecutionLoopState {
  cwd: string;
  managedAbortController: ReturnType<typeof createManagedAbortController>;
  maxIterations: number;
  memoryContext: ContextFragment[];
  memoryRecall: MemoryRecallResult | null;
  messages: ConversationMessage[];
  /** Present only when the CLI/TUI requests streamed assistant text. */
  onAssistantTextDelta?: (delta: string) => void;
  onTaskEvent?: (event: RuntimeTaskEvent) => void;
  pendingToolCalls: ProviderToolCall[];
  skillContext: ContextFragment[];
  repoMapSummary?: string;
  task: TaskRecord;
  tokenBudget: TokenBudget;
}

export class ExecutionKernel {
  private readonly contextAssembler = new ExecutionContextAssembler();

  public constructor(private readonly dependencies: ExecutionKernelDependencies) {}

  public async run(options: RuntimeRunOptions): Promise<RuntimeRunResult> {
    const taskId = options.taskId ?? randomUUID();
    let task = this.dependencies.taskRepository.create({
      agentProfileId: options.agentProfileId,
      cwd: options.cwd,
      input: options.taskInput,
      maxIterations: options.maxIterations,
      metadata: options.metadata ?? {},
      providerName: this.dependencies.provider.name,
      requesterUserId: options.userId,
      taskId,
      tokenBudget: options.tokenBudget
    });

    this.dependencies.traceService.record({
      actor: "runtime.kernel",
      eventType: "task_created",
      payload: {
        agentProfileId: options.agentProfileId,
        cwd: options.cwd,
        input: options.taskInput,
        providerName: this.dependencies.provider.name,
        requesterUserId: options.userId
      },
      stage: "lifecycle",
      summary: "Task persisted",
      taskId
    });

    this.dependencies.runMetadataRepository.create({
      agentProfileId: options.agentProfileId,
      createdAt: new Date().toISOString(),
      metadata: options.metadata ?? {},
      providerName: this.dependencies.provider.name,
      requesterUserId: options.userId,
      runMetadataId: randomUUID(),
      runtimeVersion: this.dependencies.runtimeVersion,
      taskId,
      timeoutMs: options.timeoutMs,
      tokenBudget: options.tokenBudget,
      workspaceRoot: this.dependencies.workspaceRoot
    });

    const managedAbortController = createManagedAbortController(
      options.timeoutMs,
      options.signal
    );

    try {
      task = this.dependencies.taskRepository.update(taskId, {
        startedAt: new Date().toISOString(),
        status: "running"
      });
      emitTaskEvent(options.onTaskEvent, {
        iteration: task.currentIteration,
        kind: "lifecycle",
        message: "Task started",
        status: task.status,
        taskId
      });

      this.dependencies.traceService.record({
        actor: "runtime.kernel",
        eventType: "task_started",
        payload: {
          maxIterations: options.maxIterations,
          timeoutMs: options.timeoutMs
        },
        stage: "lifecycle",
        summary: "Task execution started",
        taskId
      });

      const profile = this.dependencies.agentProfileRegistry.get(options.agentProfileId);
      this.dependencies.memoryPlane.rememberTaskGoal(task);
      const memoryContext = this.dependencies.memoryPlane.buildContext(task);
      const skillContext = this.dependencies.skillContextService.buildContext(task);
      const availableTools = this.dependencies.toolOrchestrator.listTools(profile.allowedToolNames);
      const repoMap = this.dependencies.workflow.repoMap.enabled
        ? buildRepoMap(this.dependencies.workspaceRoot)
        : null;
      const messages = this.contextAssembler.buildInitialMessages(
        task,
        availableTools,
        profile,
        repoMap?.summary
      );
      if (repoMap !== null) {
        this.dependencies.traceService.record({
          actor: "runtime.repo_map",
          eventType: "repo_map_created",
          payload: {
            importantFiles: repoMap.importantFiles,
            languages: repoMap.languages,
            packageManager: repoMap.packageManager,
            scripts: repoMap.scripts
          },
          stage: "planning",
          summary: repoMap.summary,
          taskId
        });
      }

      return await this.executeLoop({
        cwd: options.cwd,
        managedAbortController,
        maxIterations: options.maxIterations,
        memoryContext: [...memoryContext.fragments, ...skillContext],
        memoryRecall: memoryContext.recall,
        messages,
        ...(options.onAssistantTextDelta !== undefined
          ? { onAssistantTextDelta: options.onAssistantTextDelta }
          : {}),
        ...(options.onTaskEvent !== undefined ? { onTaskEvent: options.onTaskEvent } : {}),
        pendingToolCalls: [],
        ...(repoMap?.summary !== undefined ? { repoMapSummary: repoMap.summary } : {}),
        skillContext,
        task,
        tokenBudget: options.tokenBudget
      });
    } catch (error) {
      throw this.finalizeTaskFailure(task, toAppError(error), options.onTaskEvent);
    } finally {
      managedAbortController.dispose();
    }
  }

  public async resumeTask(taskId: string, signal?: AbortSignal): Promise<RuntimeRunResult> {
    const task = this.dependencies.taskRepository.findById(taskId);
    if (task === null) {
      throw new AppError({
        code: "task_not_found",
        message: `Task ${taskId} was not found.`
      });
    }

    if (task.status !== "waiting_approval") {
      throw new AppError({
        code: "task_not_resumable",
        message: `Task ${taskId} is not waiting for approval.`
      });
    }

    const checkpoint = this.dependencies.executionCheckpointRepository.findByTaskId(taskId);
    if (checkpoint === null) {
      throw new AppError({
        code: "task_not_resumable",
        message: `Task ${taskId} has no execution checkpoint to resume.`
      });
    }

    const runMetadata = this.dependencies.runMetadataRepository.findByTaskId(taskId);
    if (runMetadata === null) {
      throw new AppError({
        code: "task_not_resumable",
        message: `Task ${taskId} has no run metadata to resume from.`
      });
    }

    const managedAbortController = createManagedAbortController(runMetadata.timeoutMs, signal);
    let resumedTask = this.dependencies.taskRepository.update(taskId, {
      status: "running"
    });

    try {
      return await this.executeLoop({
        cwd: resumedTask.cwd,
        managedAbortController,
        maxIterations: resumedTask.maxIterations,
        memoryContext: checkpoint.memoryContext,
        memoryRecall: null,
        messages: checkpoint.messages,
        pendingToolCalls: checkpoint.pendingToolCalls,
        skillContext: [],
        task: resumedTask,
        tokenBudget: resumedTask.tokenBudget
      });
    } catch (error) {
      resumedTask = this.dependencies.taskRepository.findById(taskId) ?? resumedTask;
      throw this.finalizeTaskFailure(resumedTask, toAppError(error));
    } finally {
      managedAbortController.dispose();
    }
  }

  public failWaitingApprovalTask(taskId: string, error: AppError): TaskRecord {
    const task = this.dependencies.taskRepository.findById(taskId);
    if (task === null) {
      throw new AppError({
        code: "task_not_found",
        message: `Task ${taskId} was not found.`
      });
    }

    if (task.status !== "waiting_approval") {
      return task;
    }

    this.dependencies.executionCheckpointRepository.delete(taskId);
    const failedTask = this.dependencies.taskRepository.update(taskId, {
      errorCode: error.code,
      errorMessage: error.message,
      finishedAt: new Date().toISOString(),
      status: "failed"
    });

    this.dependencies.traceService.record({
      actor: "runtime.kernel",
      eventType: "final_outcome",
      payload: {
        errorCode: error.code,
        errorMessage: error.message,
        output: null,
        status: "failed"
      },
      stage: "completion",
      summary: "Task finished with an approval failure",
      taskId
    });

    return failedTask;
  }

  private async executeLoop(state: ExecutionLoopState): Promise<RuntimeRunResult> {
    const profile = this.dependencies.agentProfileRegistry.get(state.task.agentProfileId);
    const availableTools = this.dependencies.toolOrchestrator.listTools(profile.allowedToolNames);
    let task = state.task;
    const messages = [...state.messages];
    let pendingToolCalls = [...state.pendingToolCalls];

    for (
      let iteration = pendingToolCalls.length > 0 ? task.currentIteration : task.currentIteration + 1;
      iteration <= state.maxIterations;
      iteration += 1
    ) {
      throwIfAborted(
        state.managedAbortController.abortController.signal,
        state.managedAbortController.getReason()
      );

      task = this.dependencies.taskRepository.update(task.taskId, {
        currentIteration: iteration
      });

      if (pendingToolCalls.length === 0) {
        const assembled = this.contextAssembler.assemble({
          availableTools,
          iteration,
          memoryContext: state.memoryContext,
          messages,
          signal: state.managedAbortController.abortController.signal,
          task,
          tokenBudget: state.tokenBudget
        });
        assembled.debug.filteredOutFragments =
          state.memoryRecall === null
            ? []
            : buildFilteredContextDebugFragments(state.memoryRecall.decisions);
        const providerInput =
          state.onAssistantTextDelta === undefined
            ? assembled.providerInput
            : {
                ...assembled.providerInput,
                onTextDelta: state.onAssistantTextDelta
              };

        this.dependencies.traceService.record({
          actor: "runtime.context",
          eventType: "context_assembled",
          payload: {
            debugView: assembled.debug,
            iteration
          },
          stage: "planning",
          summary: `Context assembled with ${assembled.debug.memoryRecallFragments.length} recall fragments`,
          taskId: task.taskId
        });

        this.dependencies.traceService.record({
          actor: `provider.${this.dependencies.provider.name}`,
          eventType: "provider_request_started",
          payload: {
            inputMessageCount: messages.length,
            iteration,
            modelName: this.dependencies.provider.model ?? this.dependencies.provider.describe?.().model ?? null,
            providerName: this.dependencies.provider.name
          },
          stage: "planning",
          summary: "Provider request started",
          taskId: task.taskId
        });

        this.dependencies.traceService.record({
          actor: `provider.${this.dependencies.provider.name}`,
          eventType: "model_request",
          payload: {
            agentProfileId: task.agentProfileId,
            availableTools: availableTools.map((tool) => tool.name),
            inputMessageCount: messages.length,
            iteration,
            tokenBudget: tokenBudgetToJson(state.tokenBudget)
          },
          stage: "planning",
          summary: "Provider request assembled",
          taskId: task.taskId
        });

        const startedAt = Date.now();
        let providerResponse;
        try {
          providerResponse = await this.dependencies.provider.generate(providerInput);
        } catch (error) {
          const providerError = normalizeProviderFailure(error, this.dependencies.provider);
          this.dependencies.traceService.record({
            actor: `provider.${this.dependencies.provider.name}`,
            eventType: "provider_request_failed",
            payload: {
              errorCategory: providerError.category,
              iteration,
              latencyMs: Date.now() - startedAt,
              modelName: providerError.modelName ?? this.dependencies.provider.model ?? null,
              providerName: this.dependencies.provider.name,
              retryCount: providerError.retryCount
            },
            stage: "planning",
            summary: `Provider request failed with ${providerError.category}`,
            taskId: task.taskId
          });
          throw providerError;
        }

        messages.push({
          content: providerResponse.message,
          role: "assistant",
          ...(providerResponse.metadata?.raw !== undefined
            ? { metadata: providerResponse.metadata.raw }
            : {}),
          ...(providerResponse.kind === "tool_calls"
            ? { toolCalls: providerResponse.toolCalls }
            : {})
        });

        this.dependencies.traceService.record({
          actor: `provider.${this.dependencies.provider.name}`,
          eventType: "provider_request_succeeded",
          payload: {
            iteration,
            kind: providerResponse.kind,
            latencyMs: Date.now() - startedAt,
            modelName:
              providerResponse.metadata?.modelName ??
              this.dependencies.provider.model ??
              this.dependencies.provider.describe?.().model ??
              null,
            providerName:
              providerResponse.metadata?.providerName ?? this.dependencies.provider.name,
            retryCount: providerResponse.metadata?.retryCount ?? 0,
            usage: providerUsageToJson(providerResponse.usage)
          },
          stage: "planning",
          summary: `Provider request completed with ${providerResponse.kind}`,
          taskId: task.taskId
        });

        this.dependencies.traceService.record({
          actor: `provider.${this.dependencies.provider.name}`,
          eventType: "model_response",
          payload: {
            iteration,
            kind: providerResponse.kind,
            message: providerResponse.message,
            toolNames:
              providerResponse.kind === "tool_calls"
                ? providerResponse.toolCalls.map((call) => call.toolName)
                : []
          },
          stage: "planning",
          summary: `Provider responded with ${providerResponse.kind}`,
          taskId: task.taskId
        });

        if (task.agentProfileId === "reviewer") {
          this.dependencies.traceService.record({
            actor: "reviewer.trace",
            eventType: "reviewer_trace",
            payload: buildReviewerTracePayload(iteration, assembled.debug, providerResponse),
            stage: "planning",
            summary: "Reviewer decision trace captured",
            taskId: task.taskId
          });
        }

        if (providerResponse.kind === "retry") {
          this.dependencies.traceService.record({
      actor: "runtime.kernel",
      eventType: "retry",
      payload: {
        delayMs: providerResponse.delayMs,
              iteration,
              reason: providerResponse.reason
            },
            stage: "control",
            summary: "Retry requested by provider",
            taskId: task.taskId
          });

          await sleepWithAbort(
            providerResponse.delayMs,
            state.managedAbortController.abortController.signal
          );

          this.dependencies.traceService.record({
            actor: "runtime.kernel",
            eventType: "loop_iteration_completed",
            payload: {
              iteration,
              toolCallCount: 0
            },
            stage: "control",
            summary: "Loop iteration completed after retry",
            taskId: task.taskId
          });
          continue;
        }

        if (providerResponse.kind === "final") {
          this.dependencies.executionCheckpointRepository.delete(task.taskId);
          task = this.dependencies.taskRepository.update(task.taskId, {
            finalOutput: providerResponse.message,
            finishedAt: new Date().toISOString(),
            status: "succeeded"
          });
          this.dependencies.memoryPlane.recordFinalOutcome(task, providerResponse.message);

          this.dependencies.traceService.record({
            actor: "runtime.kernel",
            eventType: "final_outcome",
            payload: {
              errorCode: null,
              errorMessage: null,
              output: providerResponse.message,
              status: "succeeded"
            },
            stage: "completion",
            summary: "Task completed successfully",
            taskId: task.taskId
          });
          this.dependencies.traceService.record({
            actor: "runtime.kernel",
            eventType: "task_success",
            payload: {
              cwd: task.cwd,
              outputSummary: summarizeText(providerResponse.message, 240),
              status: "succeeded"
            },
            stage: "lifecycle",
            summary: "Task success lifecycle hook published",
            taskId: task.taskId
          });
          this.dependencies.traceService.record({
            actor: "runtime.kernel",
            eventType: "session_end",
            payload: {
              status: "succeeded",
              summary: summarizeText(providerResponse.message, 240)
            },
            stage: "lifecycle",
            summary: "Session end lifecycle hook published",
            taskId: task.taskId
          });
          emitTaskEvent(state.onTaskEvent, {
            errorCode: null,
            errorMessage: null,
            kind: "result",
            outputPreview: summarizeText(providerResponse.message, 200),
            status: "succeeded",
            taskId: task.taskId
          });

          return {
            output: providerResponse.message,
            task
          };
        }

        task = this.dependencies.taskRepository.update(task.taskId, {
          status: "waiting_tool"
        });
        pendingToolCalls = providerResponse.toolCalls;
      }

      let toolCallCount = 0;
      for (const [toolIndex, toolCall] of pendingToolCalls.entries()) {
        throwIfAborted(
          state.managedAbortController.abortController.signal,
          state.managedAbortController.getReason()
        );
        emitTaskEvent(state.onTaskEvent, {
          iteration,
          kind: "tool",
          status: "started",
          taskId: task.taskId,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName
        });

        const outcome = await this.dependencies.toolOrchestrator.execute(
          {
            input: toolCall.input,
            iteration,
            reason: toolCall.reason,
            taskId: task.taskId,
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName
          },
          {
            agentProfileId: task.agentProfileId,
            cwd: state.cwd,
            iteration,
            signal: state.managedAbortController.abortController.signal,
            taskId: task.taskId,
            userId: task.requesterUserId,
            workspaceRoot: this.dependencies.workspaceRoot
          }
        );

        if (outcome.kind === "approval_required") {
          task = this.dependencies.taskRepository.update(task.taskId, {
            status: "waiting_approval"
          });

          emitTaskEvent(state.onTaskEvent, {
            iteration,
            kind: "tool",
            status: "approval_required",
            taskId: task.taskId,
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName
          });
          this.dependencies.executionCheckpointRepository.save({
            iteration,
            memoryContext: state.memoryContext,
            messages,
            pendingToolCalls: pendingToolCalls.slice(toolIndex),
            taskId: task.taskId,
            updatedAt: new Date().toISOString()
          });

          return {
            output: null,
            task
          };
        }

        toolCallCount += 1;
        const toolDescriptor = this.dependencies.toolOrchestrator.describeTool(toolCall.toolName);
        const structuredOutputSummary = summarizeToolOutput(outcome.result.output);
        const toolSummary = `${outcome.result.summary} | ${structuredOutputSummary}`;
        if (toolDescriptor !== null) {
          this.dependencies.memoryPlane.recordToolOutcome({
            output:
              typeof outcome.result.output === "string"
                ? outcome.result.output
                : JSON.stringify(outcome.result.output, null, 2),
            privacyLevel: toolDescriptor.privacyLevel,
            summary: toolSummary,
            task,
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName
          });
          messages.push(
            createToolFeedbackMessage(outcome.result.output, toolCall, toolDescriptor.privacyLevel)
          );
          emitTaskEvent(state.onTaskEvent, {
            iteration,
            kind: "tool",
            status: "finished",
            summary: toolSummary,
            taskId: task.taskId,
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName
          });
          continue;
        }
        messages.push(createToolFeedbackMessage(outcome.result.output, toolCall, "internal"));
        emitTaskEvent(state.onTaskEvent, {
          iteration,
          kind: "tool",
          status: "finished",
          summary: toolSummary,
          taskId: task.taskId,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName
        });
      }

      pendingToolCalls = [];
      this.dependencies.executionCheckpointRepository.delete(task.taskId);

      task = this.dependencies.taskRepository.update(task.taskId, {
        status: "running"
      });

      this.dependencies.traceService.record({
        actor: "runtime.kernel",
        eventType: "loop_iteration_completed",
        payload: {
          iteration,
          toolCallCount
        },
        stage: "control",
        summary: "Loop iteration completed after tool execution",
        taskId: task.taskId
      });
      this.dependencies.traceService.record({
        actor: "runtime.kernel",
        eventType: "turn_end",
        payload: {
          iteration,
          taskStatus: task.status,
          toolCallCount
        },
        stage: "lifecycle",
        summary: "Turn end lifecycle hook published",
        taskId: task.taskId
      });

      this.dependencies.traceService.record({
        actor: "runtime.kernel",
        eventType: "pre_compress",
        payload: {
          messageCount: messages.length,
          reason: "message_count"
        },
        stage: "lifecycle",
        summary: "Pre-compress lifecycle hook published",
        taskId: task.taskId
      });
      const compacted = await this.dependencies.memoryPlane.compactSession({
        maxMessagesBeforeCompact: this.dependencies.compact.messageThreshold,
        messages,
        pendingToolCalls,
        sessionScopeKey: task.taskId,
        taskId: task.taskId,
        tokenEstimate: estimateTokenCount(messages),
        tokenThreshold: this.dependencies.compact.tokenThreshold,
        toolCallCount,
        toolCallThreshold: this.dependencies.compact.toolCallThreshold
      });
      if (compacted.triggered) {
        const initialSystemPrompt =
          messages.find((message) => message.role === "system") ?? null;
        messages.length = 0;
        if (initialSystemPrompt !== null) {
          messages.push(initialSystemPrompt);
        }
        if (state.repoMapSummary !== undefined) {
          messages.push({
            content: state.repoMapSummary,
            metadata: {
              privacyLevel: "internal",
              retentionKind: "session",
              sourceType: "system_prompt"
            },
            role: "system"
          });
        }
        messages.push({
          content: buildCapabilityDeclaration({
            agentProfileId: task.agentProfileId,
            availableTools,
            skillContext: state.skillContext
          }),
          metadata: {
            privacyLevel: "internal",
            retentionKind: "session",
            sourceType: "system_prompt"
          },
          role: "system"
        });
        messages.push(...compacted.replacementMessages);
        const refreshedContext = this.dependencies.memoryPlane.buildContext(task);
        state.memoryContext = [...refreshedContext.fragments, ...state.skillContext];
        state.memoryRecall = refreshedContext.recall;
      }
    }

    throw new AppError({
      code: "max_rounds_exceeded",
      message: `Task exceeded ${state.maxIterations} iterations.`
    });
  }

  private finalizeTaskFailure(
    task: TaskRecord,
    error: AppError,
    onTaskEvent?: (event: RuntimeTaskEvent) => void
  ): AppError {
    const isCancelled = error.code === "interrupt";

    if (error.code === "interrupt" || error.code === "timeout") {
      this.dependencies.traceService.record({
        actor: "runtime.kernel",
        eventType: "interrupt",
        payload: {
          iteration: task.currentIteration,
          reason: error.message
        },
        stage: "control",
        summary: `Task interrupted with ${error.code}`,
        taskId: task.taskId
      });
    }

    this.dependencies.executionCheckpointRepository.delete(task.taskId);
    this.dependencies.taskRepository.update(task.taskId, {
      errorCode: error.code,
      errorMessage: error.message,
      finishedAt: new Date().toISOString(),
      status: isCancelled ? "cancelled" : "failed"
    });
    emitTaskEvent(onTaskEvent, {
      errorCode: error.code,
      errorMessage: error.message,
      kind: "result",
      outputPreview: null,
      status: isCancelled ? "cancelled" : "failed",
      taskId: task.taskId
    });

    this.dependencies.traceService.record({
      actor: "runtime.kernel",
      eventType: "final_outcome",
      payload: {
        errorCode: error.code,
        errorMessage: error.message,
        output: null,
        status: isCancelled ? "cancelled" : "failed"
      },
      stage: "completion",
      summary: "Task finished with an error",
      taskId: task.taskId
    });
    this.dependencies.traceService.record({
      actor: "runtime.kernel",
      eventType: "task_failure",
      payload: {
        cwd: task.cwd,
        errorCode: error.code,
        errorMessage: error.message,
        status: isCancelled ? "cancelled" : "failed"
      },
      stage: "lifecycle",
      summary: "Task failure lifecycle hook published",
      taskId: task.taskId
    });
    this.dependencies.traceService.record({
      actor: "runtime.kernel",
      eventType: "session_end",
      payload: {
        status: isCancelled ? "cancelled" : "failed",
        summary: error.message
      },
      stage: "lifecycle",
      summary: "Session end lifecycle hook published",
      taskId: task.taskId
    });

    return new AppError({
      cause: error,
      code: error.code,
      details: {
        ...(error.details ?? {}),
        taskId: task.taskId
      },
      message: error.message
    });
  }
}

function providerUsageToJson(usage: {
  cachedInputTokens?: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
}): Record<string, number> {
  const payload: Record<string, number> = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens
  };

  if (usage.totalTokens !== undefined) {
    payload.totalTokens = usage.totalTokens;
  }

  if (usage.cachedInputTokens !== undefined) {
    payload.cachedInputTokens = usage.cachedInputTokens;
  }

  return payload;
}

function createToolFeedbackMessage(
  output: unknown,
  toolCall: { toolCallId: string; toolName: string },
  privacyLevel: "public" | "internal" | "restricted"
): ConversationMessage {
  return {
    content: JSON.stringify(output, null, 2),
    metadata: {
      privacyLevel,
      retentionKind: "session",
      sourceType: "tool_result"
    },
    role: "tool",
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName
  };
}

function buildReviewerTracePayload(
  iteration: number,
  debug: ContextAssemblyDebugView,
  providerResponse: { kind: "final" | "retry" | "tool_calls"; message: string }
): {
  blockingReason: string | null;
  continuationBlocked: boolean;
  iteration: number;
  reviewerJudgementSummary: string;
  reviewerSeenSummary: string;
  riskDetected: boolean;
} {
  const reviewerSeenSummary = summarizeText(
    [
      debug.originalTaskInput.preview,
      ...debug.systemPromptFragments.map((fragment) => fragment.preview),
      ...debug.memoryRecallFragments.map((fragment) => fragment.preview),
      ...debug.toolResultFragments.map((fragment) => fragment.preview)
    ]
      .filter(Boolean)
      .join(" | "),
    260
  );
  const reviewerJudgementSummary = summarizeText(providerResponse.message, 220);
  const lowered = providerResponse.message.toLowerCase();
  const riskDetected =
    lowered.includes("risk") ||
    lowered.includes("block") ||
    lowered.includes("unsafe") ||
    lowered.includes("deny") ||
    lowered.includes("stop");
  const continuationBlocked = providerResponse.kind === "final" && riskDetected;

  return {
    blockingReason: continuationBlocked ? reviewerJudgementSummary : null,
    continuationBlocked,
    iteration,
    reviewerJudgementSummary,
    reviewerSeenSummary,
    riskDetected
  };
}

function normalizeProviderFailure(
  error: unknown,
  provider: Provider
): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }

  if (error instanceof Error) {
    return new ProviderError({
      category: "unknown_error",
      cause: error,
      message: error.message,
      modelName: provider.model ?? provider.describe?.().model ?? undefined,
      providerName: provider.name,
      summary: "The provider failed with an unexpected error."
    });
  }

  return new ProviderError({
    category: "unknown_error",
    cause: error,
    message: "Unknown provider failure.",
    modelName: provider.model ?? provider.describe?.().model ?? undefined,
    providerName: provider.name,
    summary: "The provider failed with an unknown error."
  });
}

async function sleepWithAbort(delayMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(
        new AppError({
          code: "interrupt",
          message: "Retry wait interrupted."
        })
      );
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function summarizeText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength)}...`;
}

function emitTaskEvent(
  callback: ((event: RuntimeTaskEvent) => void) | undefined,
  event: RuntimeTaskEvent
): void {
  if (callback === undefined) {
    return;
  }
  callback(event);
}

function summarizeToolOutput(output: unknown): string {
  if (typeof output === "string") {
    return summarizeText(output, 140);
  }
  if (output === null || output === undefined) {
    return "output=null";
  }
  if (Array.isArray(output)) {
    return `output=array(${output.length})`;
  }
  if (typeof output === "object") {
    const keys = Object.keys(output as Record<string, unknown>);
    return `output=object{${keys.slice(0, 6).join(",")}${keys.length > 6 ? ",..." : ""}}`;
  }
  if (typeof output === "number" || typeof output === "boolean" || typeof output === "bigint") {
    return `output=${output.toString()}`;
  }
  if (typeof output === "symbol") {
    return `output=${output.description ?? "symbol"}`;
  }
  return "output=[unsupported]";
}

function estimateTokenCount(messages: ConversationMessage[]): number {
  const joined = messages.map((message) => message.content).join("\n");
  return Math.ceil(joined.length / 4);
}
