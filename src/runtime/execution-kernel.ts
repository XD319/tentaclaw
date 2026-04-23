import { randomUUID } from "node:crypto";

import { createManagedAbortController, throwIfAborted } from "./abort-controller.js";
import { AppError, toAppError } from "./app-error.js";
import { computeCostUsd } from "./budget/cost-calculator.js";
import {
  buildFilteredContextDebugFragments,
  ExecutionContextAssembler
} from "./context-assembler.js";
import { buildRepoMap } from "./repo-map.js";
import { tokenBudgetToJson } from "./serialization.js";
import type { ContextCompactor, SessionSnapshotService } from "./context/index.js";
import type { RecallPlanner } from "./retrieval/index.js";
import type { RuntimeConfig, WorkflowRuntimeConfig } from "./runtime-config.js";
import { ProviderError } from "../providers/index.js";
import type { ProviderRouter } from "../providers/routing/provider-router.js";
import type { AgentProfileRegistry } from "../profiles/agent-profile-registry.js";
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
  ThreadCommitmentState,
  ThreadLineageRepository,
  ThreadRunRepository,
  TokenBudget,
  BudgetPricingEntry
} from "../types/index.js";
import type { MemoryPlane } from "../memory/memory-plane.js";
import { buildCapabilityDeclaration } from "../memory/capability-declaration-builder.js";
import type { ToolOrchestrator } from "../tools/index.js";
import type { TraceService } from "../tracing/trace-service.js";
import type { BudgetService } from "./budget/budget-service.js";

export interface ExecutionKernelDependencies {
  agentProfileRegistry: AgentProfileRegistry;
  executionCheckpointRepository: ExecutionCheckpointRepository;
  getThreadCommitmentState?: (threadId: string) => ThreadCommitmentState | null;
  memoryPlane: MemoryPlane;
  recallPlanner: RecallPlanner;
  provider: Provider;
  runMetadataRepository: RunMetadataRepository;
  runtimeVersion: string;
  taskRepository: TaskRepository;
  threadRunRepository: ThreadRunRepository;
  threadLineageRepository: ThreadLineageRepository;
  contextCompactor: ContextCompactor;
  sessionSnapshotService: SessionSnapshotService;
  toolOrchestrator: ToolOrchestrator;
  traceService: TraceService;
  workflow: WorkflowRuntimeConfig;
  compact: RuntimeConfig["compact"];
  budgetPricing?: Record<string, BudgetPricingEntry>;
  budgetService?: BudgetService;
  providerRouter?: ProviderRouter;
  routingMode?: "cheap_first" | "balanced" | "quality_first";
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
  selectedSkillContext: ContextFragment[];
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
      threadId: options.threadId ?? null,
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
      const availableTools = this.dependencies.toolOrchestrator.listTools(profile.allowedToolNames);
      const threadId = task.threadId ?? null;
      const recallPlan = this.dependencies.recallPlanner.plan({
        task,
        threadCommitmentState:
          threadId === null ? null : this.dependencies.getThreadCommitmentState?.(threadId) ?? null,
        tokenBudget: options.tokenBudget,
        toolPlan: availableTools.map((tool) => tool.name)
      });
      const repoMap = this.dependencies.workflow.repoMap.enabled
        ? buildRepoMap(this.dependencies.workspaceRoot)
        : null;
      const messages = this.contextAssembler.buildInitialMessages(
        task,
        availableTools,
        profile,
        repoMap?.summary
      );
      const resumeContextMessages = readThreadResumeMessages(options.metadata);
      if (resumeContextMessages.length > 0) {
        injectResumeContextMessages(messages, resumeContextMessages);
      }
      const resumeMemoryContext = readThreadResumeMemoryContext(options.metadata);
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
        memoryContext: [...recallPlan.fragments, ...resumeMemoryContext],
        memoryRecall: null,
        messages,
        ...(options.onAssistantTextDelta !== undefined
          ? { onAssistantTextDelta: options.onAssistantTextDelta }
          : {}),
        ...(options.onTaskEvent !== undefined ? { onTaskEvent: options.onTaskEvent } : {}),
        pendingToolCalls: [],
        ...(repoMap?.summary !== undefined ? { repoMapSummary: repoMap.summary } : {}),
        selectedSkillContext: recallPlan.fragments.filter((fragment) => fragment.scope === "skill_ref"),
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
        selectedSkillContext: [],
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

        const activeProvider =
          this.dependencies.providerRouter?.selectProvider({
            kind: "main",
            taskId: task.taskId,
            threadId: task.threadId ?? null,
            ...(this.dependencies.routingMode !== undefined
              ? { mode: this.dependencies.routingMode }
              : {})
          }).provider ?? this.dependencies.provider;

        this.dependencies.traceService.record({
          actor: `provider.${activeProvider.name}`,
          eventType: "provider_request_started",
          payload: {
            inputMessageCount: messages.length,
            iteration,
            modelName: activeProvider.model ?? activeProvider.describe?.().model ?? null,
            providerName: activeProvider.name
          },
          stage: "planning",
          summary: "Provider request started",
          taskId: task.taskId
        });

        this.dependencies.traceService.record({
          actor: `provider.${activeProvider.name}`,
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
          providerResponse = await activeProvider.generate(providerInput);
        } catch (error) {
          const providerError = normalizeProviderFailure(error, activeProvider);
          this.dependencies.traceService.record({
            actor: `provider.${activeProvider.name}`,
            eventType: "provider_request_failed",
            payload: {
              errorCategory: providerError.category,
              iteration,
              latencyMs: Date.now() - startedAt,
              modelName: providerError.modelName ?? activeProvider.model ?? null,
              providerName: activeProvider.name,
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
          actor: `provider.${activeProvider.name}`,
          eventType: "provider_request_succeeded",
          payload: {
            iteration,
            kind: providerResponse.kind,
            latencyMs: Date.now() - startedAt,
            modelName:
              providerResponse.metadata?.modelName ??
              activeProvider.model ??
              activeProvider.describe?.().model ??
              null,
            providerName:
              providerResponse.metadata?.providerName ?? activeProvider.name,
            retryCount: providerResponse.metadata?.retryCount ?? 0,
            usage: providerUsageToJson(providerResponse.usage)
          },
          stage: "planning",
          summary: `Provider request completed with ${providerResponse.kind}`,
          taskId: task.taskId
        });

        this.dependencies.traceService.record({
          actor: `provider.${activeProvider.name}`,
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

        const resolvedProviderName = providerResponse.metadata?.providerName ?? activeProvider.name;
        const pricing = this.dependencies.budgetPricing?.[resolvedProviderName];
        const costUsd = computeCostUsd(providerResponse.usage, pricing);
        state.tokenBudget = {
          ...state.tokenBudget,
          usedCostUsd: (state.tokenBudget.usedCostUsd ?? 0) + (costUsd ?? 0),
          usedInput: (state.tokenBudget.usedInput ?? 0) + providerResponse.usage.inputTokens,
          usedOutput: (state.tokenBudget.usedOutput ?? 0) + providerResponse.usage.outputTokens
        };
        task = this.dependencies.taskRepository.update(task.taskId, {
          tokenBudget: state.tokenBudget
        });
        this.dependencies.traceService.record({
          actor: "runtime.budget",
          eventType: "cost_report",
          payload: {
            cachedInputTokens: providerResponse.usage.cachedInputTokens ?? 0,
            costUsd,
            inputTokens: providerResponse.usage.inputTokens,
            mode: this.dependencies.routingMode ?? "balanced",
            outputTokens: providerResponse.usage.outputTokens,
            providerName: resolvedProviderName,
            taskId: task.taskId,
            threadId: task.threadId ?? null
          },
          stage: "control",
          summary: "Cost usage recorded",
          taskId: task.taskId
        });
        const budgetDecision = this.dependencies.budgetService?.recordUsage({
          costUsd,
          mode: this.dependencies.routingMode ?? "balanced",
          taskId: task.taskId,
          threadId: task.threadId ?? null,
          usage: providerResponse.usage
        });
        if (budgetDecision?.action === "hard_abort") {
          throw new AppError({
            code: "budget_exceeded",
            message: budgetDecision.reasons.join("; ") || "Budget hard limit exceeded."
          });
        }

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

          this.persistThreadRun(task, task.input, {
            finalOutput: providerResponse.message,
            status: task.status
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
        const compactReason = compacted.reason ?? "message_count";
        const preCompactMessages = [...messages];
        if (task.threadId !== null && task.threadId !== undefined) {
          const latestRun = this.dependencies.threadRunRepository.findLatestByThreadId(task.threadId);
          this.dependencies.threadLineageRepository.append({
            eventType: "compress",
            lineageId: randomUUID(),
            payload: {
              messageCount: messages.length,
              reason: compactReason
            },
            sourceRunId: latestRun?.runId ?? null,
            targetRunId: latestRun?.runId ?? null,
            threadId: task.threadId
          });
          const snapshotDraft = this.dependencies.contextCompactor.buildSnapshot({
            availableTools,
            compact: {
              maxMessagesBeforeCompact: this.dependencies.compact.messageThreshold,
              messages: preCompactMessages,
              pendingToolCalls,
              reason: compactReason,
              sessionScopeKey: task.taskId,
              taskId: task.taskId,
              tokenEstimate: estimateTokenCount(preCompactMessages),
              tokenThreshold: this.dependencies.compact.tokenThreshold,
              toolCallCount,
              toolCallThreshold: this.dependencies.compact.toolCallThreshold
            },
            memoryContext: state.memoryContext,
            task
          });
          this.dependencies.sessionSnapshotService.createSnapshot({
            ...snapshotDraft,
            runId: latestRun?.runId ?? null,
            threadId: task.threadId,
            trigger: "compact"
          });
        }
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
            skillContext: state.selectedSkillContext
          }),
          metadata: {
            privacyLevel: "internal",
            retentionKind: "session",
            sourceType: "system_prompt"
          },
          role: "system"
        });
        messages.push(...compacted.replacementMessages);
        const refreshThreadId = task.threadId ?? null;
        const refreshedContext = this.dependencies.recallPlanner.plan({
          task,
          threadCommitmentState:
            refreshThreadId === null
              ? null
              : this.dependencies.getThreadCommitmentState?.(refreshThreadId) ?? null,
          tokenBudget: state.tokenBudget,
          toolPlan: availableTools.map((tool) => tool.name)
        });
        state.memoryContext = refreshedContext.fragments;
        state.memoryRecall = null;
        state.selectedSkillContext = refreshedContext.fragments.filter(
          (fragment) => fragment.scope === "skill_ref"
        );
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

    this.persistThreadRun(task, task.input, {
      errorCode: error.code,
      errorMessage: error.message,
      status: isCancelled ? "cancelled" : "failed"
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

  private persistThreadRun(
    task: TaskRecord,
    input: string,
    summary: {
      status: TaskRecord["status"];
      finalOutput?: string | null;
      errorCode?: string | null;
      errorMessage?: string | null;
    }
  ): void {
    if (task.threadId === null || task.threadId === undefined) {
      return;
    }
    if (this.dependencies.threadRunRepository.findByTaskId(task.taskId) !== null) {
      return;
    }
    this.dependencies.threadRunRepository.create({
      finishedAt: task.finishedAt,
      input,
      metadata: {
        providerName: task.providerName
      },
      runId: randomUUID(),
      status: task.status,
      summary: {
        errorCode: summary.errorCode ?? null,
        errorMessage: summary.errorMessage ?? null,
        finalOutput: summary.finalOutput ?? task.finalOutput ?? null,
        status: summary.status
      },
      taskId: task.taskId,
      threadId: task.threadId
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

function readThreadResumeMessages(metadata: RuntimeRunOptions["metadata"]): ConversationMessage[] {
  if (metadata === undefined || metadata === null) {
    return [];
  }
  const threadResume = (metadata as Record<string, unknown>).threadResume;
  if (typeof threadResume !== "object" || threadResume === null) {
    return [];
  }
  const contextMessages = (threadResume as Record<string, unknown>).contextMessages;
  if (!Array.isArray(contextMessages)) {
    return [];
  }
  return contextMessages.filter(
    (message): message is ConversationMessage =>
      typeof message === "object" &&
      message !== null &&
      typeof (message as { role?: unknown }).role === "string" &&
      typeof (message as { content?: unknown }).content === "string"
  );
}

function readThreadResumeMemoryContext(metadata: RuntimeRunOptions["metadata"]): ContextFragment[] {
  if (metadata === undefined || metadata === null) {
    return [];
  }
  const threadResume = (metadata as Record<string, unknown>).threadResume;
  if (typeof threadResume !== "object" || threadResume === null) {
    return [];
  }
  const memoryContext = (threadResume as Record<string, unknown>).memoryContext;
  if (!Array.isArray(memoryContext)) {
    return [];
  }
  return memoryContext.filter(
    (fragment): fragment is ContextFragment =>
      typeof fragment === "object" &&
      fragment !== null &&
      typeof (fragment as { memoryId?: unknown }).memoryId === "string" &&
      typeof (fragment as { text?: unknown }).text === "string"
  );
}

function injectResumeContextMessages(
  messages: ConversationMessage[],
  resumeMessages: ConversationMessage[]
): void {
  if (resumeMessages.length === 0) {
    return;
  }
  const firstSystemIndex = messages.findIndex((message) => message.role === "system");
  const insertAt = firstSystemIndex >= 0 ? firstSystemIndex + 1 : 0;
  messages.splice(insertAt, 0, ...resumeMessages);
}

function estimateTokenCount(messages: ConversationMessage[]): number {
  const joined = messages.map((message) => message.content).join("\n");
  return Math.ceil(joined.length / 4);
}
