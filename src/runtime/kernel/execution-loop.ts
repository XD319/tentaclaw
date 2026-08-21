import { randomUUID } from "node:crypto";

import { AppError } from "../app-error.js";
import { throwIfAborted } from "../abort-controller.js";
import type { ExecutionContextAssembler } from "../context-assembler.js";
import { buildFilteredContextDebugFragments } from "../context-assembler.js";
import { buildCapabilityDeclaration } from "../../memory/capability-declaration-builder.js";
import {
  computePromptTokens,
  createHybridTokenCounterState,
  estimateConversationMessageTokens,
  recordApiUsage
} from "../context/token-counter.js";
import {
  dropOldestNonSystemMessages,
  isContextOverflowProviderError
} from "../context/reactive-compact.js";
import { pruneOldToolResults, DEFAULT_TOOL_RESULT_KEEP_GROUPS } from "../context/tool-result-pruner.js";
import { syncPinnedRecentFilesMessage } from "../context/recent-file-reads.js";
import type { ManualCompactRequest } from "../context/manual-compact-coordinator.js";
import type { ContextCompactor, SessionSummaryService } from "../context/index.js";
import type { RecallPlanner } from "../retrieval/index.js";
import type { SummarizerWorker, WorkerDispatcher } from "../workers/index.js";
import type { ToolExposurePlanner, ToolExposurePlannerInput } from "../tool-exposure-planner.js";
import { generateWithProviderFailover } from "../../providers/provider-failover.js";
import {
  isAcceptableUserFinalText,
  resolveProviderFinalText
} from "../../providers/reasoning-content.js";
import type { AuditService } from "../../audit/audit-service.js";
import {
  buildReviewerTracePayload,
  findLastAssistantToolCallsResponse,
  normalizeProviderFailure,
  providerUsageToJson,
  rebuildTurnProviderMessages,
  sanitizeToolCallPairing,
  sleepWithAbort
} from "../kernel-support.js";
import { tokenBudgetToJson } from "../serialization.js";
import { buildParallelSafeLookup } from "../../tools/tool-parallel-policy.js";
import type { ToolOrchestrator } from "../../tools/index.js";
import type { TraceService } from "../../tracing/trace-service.js";
import type { CompactTriggerPolicy } from "../../memory/compact-policy.js";
import { resolveCompactCooldown } from "../../memory/compact-policy.js";
import type { ManualCompactCoordinator } from "../context/manual-compact-coordinator.js";
import type { RuntimeOutputService } from "../runtime-output-service.js";
import type { TodoItem } from "../../tools/todo-session-store.js";
import type {
  ConversationMessage,
  Provider,
  ProviderResponse,
  ProviderRetryNotice,
  ProviderStatusNotice,
  ProviderToolCall,
  ProviderToolDescriptor,
  RuntimeOutputEvent,
  RuntimeRunOptions,
  RuntimeRunResult,
  SessionCommitmentState,
  SessionCompactResult,
  SessionLineageRepository,
  SessionTaskRepository,
  TaskRecord,
  TaskRepository
} from "../../types/index.js";
import type { BudgetRecorder } from "./budget-recorder.js";
import type { CheckpointManager } from "./checkpoint-manager.js";
import type { CompletionController } from "./completion-controller.js";
import type { ExecutionLoopState } from "./execution-loop-state.js";
import { buildToolTaskMetadata } from "./tool-call-metadata.js";
import type { ToolBatchExecutor } from "./tool-batch-executor.js";

export interface ExecutionLoopCallbacks {
  buildCompactInput: (input: {
    iteration: number;
    messages: ConversationMessage[];
    pendingToolCalls: ProviderToolCall[];
    state: ExecutionLoopState;
    task: TaskRecord;
  }) => Parameters<CompactTriggerPolicy["shouldCompact"]>[0];
  compactMessages: (
    input: Parameters<CompactTriggerPolicy["shouldCompact"]>[0],
    manualRequest?: ManualCompactRequest | null
  ) => Promise<SessionCompactResult>;
  shouldCompact: (input: Parameters<CompactTriggerPolicy["shouldCompact"]>[0]) => boolean;
  completeTaskSuccess: (
    state: ExecutionLoopState,
    messages: ConversationMessage[],
    availableTools: ProviderToolDescriptor[],
    task: TaskRecord,
    finalOutput: string
  ) => RuntimeRunResult;
  emitOutput: (draft: Parameters<RuntimeOutputService["record"]>[0]) => RuntimeOutputEvent;
  flushMemory?: (input: {
    task: TaskRecord; messages: ConversationMessage[]; iteration: number;
    tokenBudget: ExecutionLoopState["tokenBudget"]; signal: AbortSignal; provider: Provider;
  }) => Promise<number>;
  planRecall: (
    input: Parameters<RecallPlanner["plan"]>[0]
  ) => Promise<ReturnType<RecallPlanner["plan"]>>;
  requestFinalSummaryWithoutTools: (
    state: ExecutionLoopState,
    messages: ConversationMessage[],
    availableTools: ProviderToolDescriptor[],
    task: TaskRecord,
    iteration: number,
    reason:
      | "max_iterations_exhausted"
      | "post_completion_verification_exhausted"
      | "empty_final_output"
      | "unpolished_final_output"
  ) => Promise<RuntimeRunResult>;
  resolveActiveMainProvider: (task: TaskRecord) => Provider;
  resolvePinnedUserMessages: (sessionId: string) => string[];
  resolveSessionTodos: (sessionId: string) => TodoItem[];
  syncRecentFileCacheMode: (
    state: ExecutionLoopState,
    pendingToolCalls: ProviderToolCall[],
    availableTools: ProviderToolDescriptor[]
  ) => void;
  syncSessionTodosContext: (input: {
    iteration?: number;
    messages: ConversationMessage[];
    task: TaskRecord;
  }) => { todoCount: number } | null;
}

export interface ExecutionLoopRunnerDependencies {
  auditService: AuditService;
  budgetRecorder: BudgetRecorder;
  checkpointManager: CheckpointManager;
  completionController: CompletionController;
  contextAssembler: ExecutionContextAssembler;
  contextCompactor: ContextCompactor;
  getSessionCommitmentState?: (sessionId: string) => SessionCommitmentState | null;
  manualCompactCoordinator?: ManualCompactCoordinator;
  provider: Provider;
  sessionLineageRepository: SessionLineageRepository;
  sessionSummaryService: SessionSummaryService;
  sessionTaskRepository: SessionTaskRepository;
  summarizerWorker?: SummarizerWorker;
  taskRepository: TaskRepository;
  toolBatchExecutor: ToolBatchExecutor;
  toolExposurePlanner?: ToolExposurePlanner;
  toolOrchestrator: ToolOrchestrator;
  traceService: TraceService;
  workerDispatcher?: WorkerDispatcher;
  workspaceRoot: string;
  toolResultKeepGroups?: number;
  compactCooldownIterations?: number;
}

export function buildToolExposurePlannerInput(input: {
  context: ToolExposurePlannerInput["context"];
  interactionMode: RuntimeRunOptions["interactionMode"];
  iteration: number;
  taskId: string;
  sessionId: string | null;
}): ToolExposurePlannerInput {
  const plannerInput: ToolExposurePlannerInput = {
    context: input.context,
    iteration: input.iteration,
    sessionId: input.sessionId,
    taskId: input.taskId
  };
  if (input.interactionMode !== undefined) {
    plannerInput.interactionMode = input.interactionMode;
  }
  return plannerInput;
}

export class ExecutionLoopRunner {
  public constructor(
    private readonly dependencies: ExecutionLoopRunnerDependencies,
    private readonly callbacks: ExecutionLoopCallbacks
  ) {}

  public async executeLoop(state: ExecutionLoopState): Promise<RuntimeRunResult> {
    let availableTools = this.dependencies.toolOrchestrator.listTools();
    let task = state.task;
    const messages = [...state.messages];
    let pendingToolCalls = [...state.pendingToolCalls];
    let lastToolCallsResponse: Extract<ProviderResponse, { kind: "tool_calls" }> | null = null;

    for (
      let iteration = pendingToolCalls.length > 0 ? task.currentIteration : task.currentIteration + 1;
      iteration <= state.maxIterations;
      iteration += 1
    ) {
      this.dependencies.completionController.maybeInjectIterationBudgetPressure(
        state,
        task.taskId,
        iteration
      );
      state.iterationsSinceLastCompact += 1;
      throwIfAborted(
        state.managedAbortController.abortController.signal,
        state.managedAbortController.getReason()
      );

      task = this.dependencies.taskRepository.update(task.taskId, {
        currentIteration: iteration
      });

      if (pendingToolCalls.length === 0) {
        const baseAvailableTools = this.dependencies.toolOrchestrator.listTools();
        if (this.dependencies.toolExposurePlanner !== undefined) {
          const exposure = await this.dependencies.toolExposurePlanner.plan(
            buildToolExposurePlannerInput({
              context: {
                agentProfileId: state.task.agentProfileId,
                cwd: state.cwd,
                iteration,
                signal: state.managedAbortController.abortController.signal,
                taskId: task.taskId,
                taskMetadata: buildToolTaskMetadata(task),
                userId: task.requesterUserId,
                workspaceRoot: this.dependencies.workspaceRoot
              },
              interactionMode: state.interactionMode,
              iteration,
              taskId: task.taskId,
              sessionId: task.sessionId ?? null
            })
          );
          availableTools = exposure.tools;
          state.costWarnedToolNames = exposure.decisions
            .filter((decision) => decision.costWarning === true)
            .map((decision) => decision.toolName);
          state.managedAbortController.touchActivity("tool_exposure_planned");
        } else {
          availableTools = baseAvailableTools;
        }
        this.callbacks.syncRecentFileCacheMode(state, pendingToolCalls, availableTools);
        sanitizeToolCallPairing(state.turnProviderMessages);
        const keepGroups = this.dependencies.toolResultKeepGroups ?? DEFAULT_TOOL_RESULT_KEEP_GROUPS;
        const pruneResult = pruneOldToolResults(state.turnProviderMessages, keepGroups);
        if (pruneResult.prunedCount > 0) {
          state.microPrunedCount += pruneResult.prunedCount;
          this.dependencies.traceService.record({
            actor: "runtime.context",
            eventType: "micro_compact_pruned",
            payload: {
              iteration,
              prunedCount: pruneResult.prunedCount,
              savedTokensEstimate: pruneResult.savedTokensEstimate
            },
            stage: "planning",
            summary: `Micro-compaction pruned ${pruneResult.prunedCount} old tool results`,
            taskId: task.taskId
          });
        }
        syncPinnedRecentFilesMessage(state.turnProviderMessages, state.recentFileReadCache);
        const injectedTodos = this.callbacks.syncSessionTodosContext({
          iteration,
          messages: state.turnProviderMessages,
          task
        });
        if (injectedTodos !== null) {
          this.dependencies.traceService.record({
            actor: "runtime.context",
            eventType: "session_todos_injected",
            payload: {
              iteration,
              todoCount: injectedTodos.todoCount
            },
            stage: "planning",
            summary: `Injected ${injectedTodos.todoCount} session todo item(s) into provider messages`,
            taskId: task.taskId
          });
        }
        const assembled = this.dependencies.contextAssembler.assemble({
          availableTools,
          filteredOutFragments: state.turnFilteredFragments,
          iteration,
          memoryContext: state.memoryContext,
          messages: state.turnProviderMessages,
          signal: state.managedAbortController.abortController.signal,
          task,
          tokenBudget: state.tokenBudget
        });
        assembled.debug.filteredOutFragments =
          (state.memoryRecall === null
            ? []
            : buildFilteredContextDebugFragments(state.memoryRecall.decisions)).concat(
            assembled.debug.filteredOutFragments
          );
        state.managedAbortController.touchActivity("context_assembled");
        if (assembled.memoryContextInjection !== null) {
          this.dependencies.traceService.record({
            actor: "runtime.context",
            eventType: "memory_context_injected",
            payload: {
              fragmentCount: assembled.memoryContextInjection.fragmentCount,
              iteration,
              tokenEstimate: assembled.memoryContextInjection.tokenEstimate
            },
            stage: "planning",
            summary: `Injected ${assembled.memoryContextInjection.fragmentCount} recall fragments into provider messages`,
            taskId: task.taskId
          });
        }
        const turnId = randomUUID();
        this.callbacks.emitOutput({
          eventType: "assistant_turn_started",
          payload: {
            display: "provisional",
            iteration,
            providerName: this.dependencies.provider.name,
            turnId
          },
          stage: "planning",
          taskId: task.taskId
        });
        let providerInput = {
          ...assembled.providerInput,
          onTextDelta: (delta: string) => {
            state.managedAbortController.touchActivity("assistant_turn_delta");
            state.onAssistantTextDelta?.(delta);
            this.callbacks.emitOutput({
              eventType: "assistant_turn_delta",
              payload: {
                delta,
                display: "provisional",
                iteration,
                turnId
              },
              stage: "planning",
              taskId: task.taskId
            });
          },
          onProviderStatus: (notice: ProviderStatusNotice) => {
            state.managedAbortController.touchActivity("provider_status");
            this.callbacks.emitOutput({
              eventType: "provider_status",
              payload: notice,
              stage: "planning",
              taskId: task.taskId
            });
          },
          onRetry: (retry: ProviderRetryNotice) => {
            state.managedAbortController.touchActivity("provider_retry_scheduled");
            this.dependencies.traceService.record({
              actor: `provider.${retry.providerName}`,
              eventType: "provider_retry_scheduled",
              payload: {
                ...retry,
                iteration
              },
              stage: "planning",
              summary: `Provider retry ${retry.attempt}/${retry.maxRetries} scheduled after ${retry.errorCategory}`,
              taskId: task.taskId
            });
          }
        };

        this.dependencies.traceService.record({
          actor: "runtime.context",
          eventType: "context_assembled",
          payload: {
            compactedCount: state.compactedCount,
            debugView: assembled.debug,
            iteration,
            microPrunedCount: state.microPrunedCount,
            promptTokenEstimate: computePromptTokens(state.tokenCounter, state.turnProviderMessages)
          },
          stage: "planning",
          summary: `Context assembled with ${assembled.debug.memoryRecallFragments.length} recall fragments`,
          taskId: task.taskId
        });

        const activeProvider = this.callbacks.resolveActiveMainProvider(task);

        this.dependencies.traceService.record({
          actor: `provider.${activeProvider.name}`,
          eventType: "provider_request_started",
          payload: {
            inputMessageCount: state.turnProviderMessages.length,
            iteration,
            modelName: activeProvider.model ?? activeProvider.describe?.().model ?? null,
            providerName: activeProvider.name
          },
          stage: "planning",
          summary: "Provider request started",
          taskId: task.taskId
        });
        state.managedAbortController.touchActivity("provider_request_started");

        this.dependencies.traceService.record({
          actor: `provider.${activeProvider.name}`,
          eventType: "model_request",
          payload: {
            agentProfileId: task.agentProfileId,
            availableTools: availableTools.map((tool) => tool.name),
            inputMessageCount: state.turnProviderMessages.length,
            iteration,
            tokenBudget: tokenBudgetToJson(state.tokenBudget)
          },
          stage: "planning",
          summary: "Provider request assembled",
          taskId: task.taskId
        });

        const startedAt = Date.now();
        let providerResponse;
        let reactiveCompactUsed = false;
        for (let providerAttempt = 0; providerAttempt < 2; providerAttempt += 1) {
          try {
            providerResponse = await generateWithProviderFailover(
              {
                auditService: this.dependencies.auditService,
                cwd: this.dependencies.workspaceRoot,
                enableFailover: true,
                primaryProvider: activeProvider,
                taskId: task.taskId,
                traceService: this.dependencies.traceService
              },
              providerInput
            );
            break;
          } catch (error) {
            const providerError = normalizeProviderFailure(error, activeProvider);
            if (
              !reactiveCompactUsed &&
              isContextOverflowProviderError(providerError)
            ) {
              const droppedFromTurn = dropOldestNonSystemMessages(state.turnProviderMessages);
              const droppedFromMessages =
                state.turnProviderMessages === messages
                  ? 0
                  : dropOldestNonSystemMessages(messages);
              if (droppedFromTurn > 0 || droppedFromMessages > 0) {
                reactiveCompactUsed = true;
                providerInput = {
                  ...providerInput,
                  ...this.dependencies.contextAssembler.assemble({
                    availableTools,
                    filteredOutFragments: state.turnFilteredFragments,
                    iteration,
                    memoryContext: state.memoryContext,
                    messages: state.turnProviderMessages,
                    signal: state.managedAbortController.abortController.signal,
                    task,
                    tokenBudget: state.tokenBudget
                  }).providerInput,
                  onProviderStatus: providerInput.onProviderStatus,
                  onRetry: providerInput.onRetry,
                  onTextDelta: providerInput.onTextDelta
                };
                this.dependencies.traceService.record({
                  actor: "runtime.context",
                  eventType: "reactive_compact_triggered",
                  payload: {
                    droppedMessageCount: Math.max(droppedFromTurn, droppedFromMessages),
                    iteration
                  },
                  stage: "planning",
                  summary: "Dropped oldest messages after provider context overflow",
                  taskId: task.taskId
                });
                continue;
              }
            }
            const abortReason = state.managedAbortController.getReason();
            const signalAborted = state.managedAbortController.abortController.signal.aborted;
            const timeoutSource =
              signalAborted && abortReason === "timeout"
                ? state.managedAbortController.timeoutMode
                : providerError.category === "timeout_error"
                  ? "provider"
                  : undefined;
            this.dependencies.traceService.record({
              actor: `provider.${activeProvider.name}`,
              eventType: "provider_request_failed",
              payload: {
                errorCategory:
                  signalAborted && abortReason === "timeout" ? "timeout_error" : providerError.category,
                errorMessage: providerError.message,
                iteration,
                lastActivityReason: state.managedAbortController.getLastActivityReason(),
                latencyMs: Date.now() - startedAt,
                modelName: providerError.modelName ?? activeProvider.model ?? null,
                providerName: activeProvider.name,
                retryCount: providerError.retryCount,
                timeoutMs: state.managedAbortController.timeoutMs,
                ...(timeoutSource !== undefined ? { timeoutSource } : {})
              },
              stage: "planning",
              summary: `Provider request failed with ${
                signalAborted && abortReason === "timeout" ? "timeout_error" : providerError.category
              }`,
              taskId: task.taskId
            });
            // Recover once from a provider-reported timeout (transient upstream
            // slowness surfaced as timeout_error without a task-level abort). A
            // task-level inactivity/wall-clock abort is intentionally terminal,
            // and a user interrupt is never revived. `taskRecoveryUsed` lives on
            // the loop state and is restored from trace on resume, so the retry
            // stays "at most once" even across a process restart.
            if (!state.taskRecoveryUsed && !signalAborted && providerError.category === "timeout_error") {
              state.taskRecoveryUsed = true;
              this.dependencies.checkpointManager.save({
                iteration,
                memoryContext: state.memoryContext,
                messages,
                pendingClarifyPromptId: null,
                pendingToolCalls,
                taskId: task.taskId
              });
              this.dependencies.traceService.record({ actor: "runtime.kernel", eventType: "task_recovery_started", payload: { iteration, reason: "provider_timeout", recoveryAttempt: 1 }, stage: "control", summary: "Retrying task once after provider timeout", taskId: task.taskId });
              state.turnProviderMessages.push({ content: "Recovery attempt: retain completed tool results and workspace changes. Continue from the remaining objective; verify changes before finalizing.", metadata: { privacyLevel: "internal", retentionKind: "session", sourceType: "system_prompt" }, role: "system" });
              continue;
            }

            throwIfAborted(state.managedAbortController.abortController.signal, abortReason);
            throw providerError;
          }
        }
        if (providerResponse === undefined) {
          throw new AppError({
            code: "provider_error",
            message: "Provider request failed after reactive compaction retry."
          });
        }
        state.managedAbortController.touchActivity("provider_request_succeeded");
        const assistantDisplay = providerResponse.kind === "final" ? "final" : "intermediate";
        const transcriptVisibility =
          providerResponse.kind === "tool_calls" ? "hidden" : "visible";

        const assistantReasoningContent =
          providerResponse.kind === "final" || providerResponse.kind === "tool_calls"
            ? providerResponse.reasoningContent
            : undefined;
        messages.push({
          content: providerResponse.message,
          role: "assistant",
          ...(providerResponse.metadata?.raw !== undefined
            ? { metadata: providerResponse.metadata.raw }
            : {}),
          ...(assistantReasoningContent !== undefined
            ? { reasoningContent: assistantReasoningContent }
            : {}),
          ...(providerResponse.kind === "tool_calls"
            ? { toolCalls: providerResponse.toolCalls }
            : {})
        });
        this.callbacks.emitOutput({
          eventType: "assistant_turn_completed",
          payload: {
            display: assistantDisplay,
            iteration,
            text: providerResponse.message,
            transcriptVisibility,
            turnId
          },
          stage: assistantDisplay === "final" ? "completion" : "planning",
          taskId: task.taskId
        });
        state.managedAbortController.touchActivity("assistant_turn_completed");

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
                ? providerResponse.toolCalls.map((call: ProviderToolCall) => call.toolName)
                : []
          },
          stage: "planning",
          summary: `Provider responded with ${providerResponse.kind}`,
          taskId: task.taskId
        });

        const resolvedProviderName = providerResponse.metadata?.providerName ?? activeProvider.name;
        const budgetResult = this.dependencies.budgetRecorder.record({
          providerName: resolvedProviderName,
          providerResponse,
          task,
          tokenBudget: state.tokenBudget
        });
        task = budgetResult.task;
        state.tokenBudget = budgetResult.tokenBudget;
        state.tokenCounter = recordApiUsage(
          state.tokenCounter,
          providerResponse.usage.inputTokens,
          messages.length - 1
        );

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
          const resolvedFinalText = resolveProviderFinalText(providerResponse) ?? "";
          const acceptance = isAcceptableUserFinalText(providerResponse, resolvedFinalText);
          if (!acceptance.acceptable) {
            this.dependencies.traceService.record({
              actor: "runtime.kernel",
              eventType:
                acceptance.reason === "empty" ? "empty_final_guarded" : "unpolished_final_guarded",
              payload: {
                iteration,
                providerName: activeProvider.name,
                ...(acceptance.reason !== null && acceptance.reason !== "empty"
                  ? { trigger: acceptance.reason }
                  : {}),
                ...(resolvedFinalText.length > 0 ? { resolvedLength: resolvedFinalText.length } : {})
              },
              stage: "completion",
              summary:
                acceptance.reason === "empty"
                  ? "Empty final response redirected to no-tools summary"
                  : `Unpolished final response redirected (${acceptance.reason ?? "unknown"})`,
              taskId: task.taskId
            });
            return this.callbacks.requestFinalSummaryWithoutTools(
              state,
              messages,
              availableTools,
              task,
              iteration,
              acceptance.reason === "empty" ? "empty_final_output" : "unpolished_final_output"
            );
          }
          const verificationDecision = this.dependencies.completionController.evaluateFinalVerification(
            state,
            messages,
            task,
            iteration,
            resolvedFinalText
          );
          if (verificationDecision.kind === "guard") {
            continue;
          }
          return this.callbacks.completeTaskSuccess(
            state,
            messages,
            availableTools,
            task,
            verificationDecision.finalOutput
          );
        }

        const postCompletionDecision = this.dependencies.completionController.evaluatePostCompletionToolCalls(
          state,
          iteration,
          providerResponse
        );
        if (postCompletionDecision === "summarize") {
          return this.callbacks.requestFinalSummaryWithoutTools(
            state,
            messages,
            availableTools,
            task,
            iteration,
            "post_completion_verification_exhausted"
          );
        }

        task = this.dependencies.taskRepository.update(task.taskId, {
          status: "waiting_tool"
        });
        pendingToolCalls = providerResponse.toolCalls;
        lastToolCallsResponse = providerResponse;
        state.managedAbortController.touchActivity("tool_call_requested");
      }

      let toolCallCount = 0;
      const parallelSafeByToolName = buildParallelSafeLookup(
        this.dependencies.toolOrchestrator.listToolsWithMetadata()
      );
      const isParallelSafe = (toolName: string): boolean =>
        parallelSafeByToolName.get(toolName) ?? false;

      let toolCallIndex = 0;
      while (toolCallIndex < pendingToolCalls.length) {
        throwIfAborted(
          state.managedAbortController.abortController.signal,
          state.managedAbortController.getReason()
        );

        const currentToolCall = pendingToolCalls[toolCallIndex];
        if (currentToolCall === undefined) {
          break;
        }

        if (!isParallelSafe(currentToolCall.toolName)) {
          const replayed = this.dependencies.toolBatchExecutor.tryApplyDuplicateToolReplay(
            state,
            messages,
            task,
            iteration,
            currentToolCall
          );
          if (replayed) {
            toolCallCount += 1;
            toolCallIndex += 1;
            continue;
          }
          const invocation = await this.dependencies.toolBatchExecutor.invokeToolCall(state, task, iteration, currentToolCall);
          const paused = this.dependencies.toolBatchExecutor.tryPauseToolExecution(
            state,
            messages,
            pendingToolCalls,
            toolCallIndex,
            task,
            iteration,
            invocation
          );
          if (paused !== null) {
            return paused;
          }
          this.dependencies.toolBatchExecutor.applyCompletedToolCallOutcome(
            state,
            messages,
            task,
            iteration,
            invocation.toolCall,
            invocation.outcome
          );
          toolCallCount += 1;
          toolCallIndex += 1;
          continue;
        }

        const batchStartIndex = toolCallIndex;
        const batchCalls: ProviderToolCall[] = [];
        while (toolCallIndex < pendingToolCalls.length) {
          const batchToolCall = pendingToolCalls[toolCallIndex];
          if (batchToolCall === undefined || !isParallelSafe(batchToolCall.toolName)) {
            break;
          }
          batchCalls.push(batchToolCall);
          toolCallIndex += 1;
        }

        const batchResult = await this.dependencies.toolBatchExecutor.executeParallelToolBatch(
          state,
          messages,
          pendingToolCalls,
          batchCalls,
          batchStartIndex,
          task,
          iteration
        );
        if (batchResult.kind === "paused") {
          return batchResult.result;
        }
        toolCallCount += batchResult.toolCallCount;
      }

      if (toolCallCount > 0) {
        const toolTurnResponse =
          lastToolCallsResponse ?? findLastAssistantToolCallsResponse(messages);
        if (toolTurnResponse !== null) {
          this.dependencies.completionController.observeProviderToolTurn(
            state,
            messages,
            task,
            iteration,
            toolTurnResponse,
            state.interactionMode ?? "agent"
          );
        }
        lastToolCallsResponse = null;
      }

      pendingToolCalls = [];
      this.dependencies.checkpointManager.delete(task.taskId);
      state.turnProviderMessages = rebuildTurnProviderMessages(messages, state.turnProviderMessages);

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
      const compactInputBase = this.callbacks.buildCompactInput({
        iteration,
        messages,
        pendingToolCalls,
        state,
        task
      });
      const manualCompactRequest =
        this.dependencies.manualCompactCoordinator?.consume(task.taskId) ?? null;
      if (manualCompactRequest !== null) {
        this.dependencies.traceService.record({
          actor: "runtime.context",
          eventType: "manual_compact_triggered",
          payload: {
            iteration,
            ...(manualCompactRequest.focusTopic !== undefined
              ? { focusTopic: manualCompactRequest.focusTopic }
              : {})
          },
          stage: "memory",
          summary: "Manual compaction requested",
          taskId: task.taskId
        });
      }
      const willCompact =
        manualCompactRequest !== null || this.callbacks.shouldCompact(compactInputBase);
      if (willCompact && this.callbacks.flushMemory !== undefined) {
        const suggestionCount = await this.callbacks.flushMemory({
          task,
          messages,
          iteration,
          tokenBudget: state.tokenBudget,
          signal: state.managedAbortController.abortController.signal,
          provider: this.callbacks.resolveActiveMainProvider(task)
        });
        this.dependencies.traceService.record({
          actor: "runtime.memory_flush",
          eventType: "memory_flush_completed",
          payload: { iteration, suggestionCount },
          stage: "memory",
          summary: `Memory flush completed with ${suggestionCount} suggestion(s)`,
          taskId: task.taskId
        });
      }
      const compacted = await this.callbacks.compactMessages(
        {
          ...compactInputBase,
          ...(manualCompactRequest?.focusTopic !== undefined
            ? { focusTopic: manualCompactRequest.focusTopic }
            : {})
        },
        manualCompactRequest
      );
      if (compacted.triggered) {
        const compactReason = compacted.reason ?? "message_count";
        const preCompactMessages = [...messages];
        if (task.sessionId !== null && task.sessionId !== undefined) {
          const sessionId = task.sessionId;
          const latestRun = this.dependencies.sessionTaskRepository.findLatestBySessionId(sessionId);
          this.dependencies.sessionLineageRepository.append({
            eventType: "compress",
            lineageId: randomUUID(),
            payload: {
              messageCount: messages.length,
              reason: compactReason
            },
            sourceRunId: latestRun?.runId ?? null,
            targetRunId: latestRun?.runId ?? null,
            sessionId
          });
          const compactInput = {
            ...this.callbacks.buildCompactInput({
              iteration,
              messages: preCompactMessages,
              pendingToolCalls,
              state,
              task
            }),
            reason: compactReason
          } as const;
          const workerDispatcher = this.dependencies.workerDispatcher;
          const summarizerWorker = this.dependencies.summarizerWorker;
          const persistCompactSummary = (): void => {
            const previousSessionSummary =
              this.dependencies.sessionSummaryService.findLatestBySession(sessionId);
            const pinnedUserMessages = this.callbacks.resolvePinnedUserMessages(sessionId);
            const sessionTodos = this.callbacks.resolveSessionTodos(sessionId);
            const sessionSummaryDraft = this.dependencies.contextCompactor.buildSessionSummary({
              availableTools,
              compact: compactInput,
              pinnedUserMessages,
              previousSessionSummary,
              sessionTodos,
              task
            });
            if (
              previousSessionSummary !== null &&
              sessionSummaryDraft.goal !== previousSessionSummary.goal
            ) {
              this.dependencies.traceService.record({
                actor: "runtime.context",
                eventType: "session_goal_updated",
                payload: {
                  previousGoal: previousSessionSummary.goal,
                  sessionId,
                  updatedGoal: sessionSummaryDraft.goal
                },
                stage: "memory",
                summary: "Session goal updated during compaction",
                taskId: task.taskId
              });
            }
            if (pinnedUserMessages.length > 0) {
              this.dependencies.traceService.record({
                actor: "runtime.context",
                eventType: "user_messages_pinned",
                payload: {
                  count: pinnedUserMessages.length,
                  sessionId
                },
                stage: "memory",
                summary: `Pinned ${pinnedUserMessages.length} user messages into session summary`,
                taskId: task.taskId
              });
            }
            const capturedConstraints = sessionSummaryDraft.decisions.filter((item) =>
              item.startsWith("Constraint:")
            );
            if (capturedConstraints.length > 0) {
              this.dependencies.traceService.record({
                actor: "runtime.context",
                eventType: "constraint_captured",
                payload: {
                  constraints: capturedConstraints,
                  sessionId
                },
                stage: "memory",
                summary: "User constraints captured into session summary",
                taskId: task.taskId
              });
            }
            if (Array.isArray(sessionSummaryDraft.metadata?.featureBacklog)) {
              this.dependencies.traceService.record({
                actor: "runtime.context",
                eventType: "feature_backlog_updated",
                payload: {
                  itemCount: sessionSummaryDraft.metadata.featureBacklog.length,
                  sessionId
                },
                stage: "memory",
                summary: "Feature backlog updated in session summary",
                taskId: task.taskId
              });
            }
            const rawCount = sessionSummaryDraft.metadata?.featureBacklogRawCount;
            const droppedCount = sessionSummaryDraft.metadata?.featureBacklogDroppedCount;
            const featureBacklog = sessionSummaryDraft.metadata?.featureBacklog;
            const filteredCount = Array.isArray(featureBacklog) ? featureBacklog.length : 0;
            if (
              typeof rawCount === "number" &&
              typeof droppedCount === "number" &&
              droppedCount > 0
            ) {
              this.dependencies.traceService.record({
                actor: "runtime.context",
                eventType: "feature_backlog_filtered",
                payload: {
                  droppedCount,
                  filteredCount,
                  rawCount,
                  sessionId
                },
                stage: "memory",
                summary: `Filtered ${droppedCount} noisy feature backlog item(s)`,
                taskId: task.taskId
              });
            }
            this.dependencies.sessionSummaryService.create({
              ...sessionSummaryDraft,
              metadata: {
                ...(sessionSummaryDraft.metadata ?? {}),
                compactReason,
                replacedMessageCount: Math.max(
                  0,
                  preCompactMessages.length - compacted.replacementMessages.length
                )
              },
              runId: latestRun?.runId ?? null,
              sessionId,
              trigger: "compact"
            });
          };
          if (workerDispatcher !== undefined && summarizerWorker !== undefined) {
            const workerResult = await workerDispatcher.dispatch(
              {
                backoffBaseMs: 150,
                backoffMaxMs: 1000,
                input: {
                  availableTools,
                  compactInput,
                  compactResult: compacted,
                  runId: latestRun?.runId ?? null,
                  sessionTodos: this.callbacks.resolveSessionTodos(sessionId),
                  task
                },
                maxAttempts: 2,
                taskId: task.taskId,
                sessionId,
                timeoutMs: 5_000,
                workerId: randomUUID(),
                workerKind: "summarizer"
              },
              (input) => summarizerWorker.execute(input)
            );
            if (workerResult.status !== "succeeded") {
              persistCompactSummary();
            }
          } else {
            persistCompactSummary();
          }
        }
        const initialSystemPrompt =
          messages.find((message) => message.role === "system") ?? null;
        messages.length = 0;
        state.silentToolTurns = 0;
        state.readOnlyTurns = 0;
        state.cumulativeToolCallCount = 0;
        state.iterationsSinceLastCompact = 0;
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
            costWarnedToolNames: state.costWarnedToolNames,
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
        syncPinnedRecentFilesMessage(messages, state.recentFileReadCache);
        this.callbacks.syncSessionTodosContext({
          messages,
          task
        });
        state.compactedCount += 1;
        state.tokenCounter = createHybridTokenCounterState();
        const refreshSessionId = task.sessionId ?? null;
        const refreshedContext = await this.callbacks.planRecall({
          task,
          sessionCommitmentState:
            refreshSessionId === null
              ? null
              : this.dependencies.getSessionCommitmentState?.(refreshSessionId) ?? null,
          tokenBudget: state.tokenBudget,
          toolPlan: availableTools.map((tool) => tool.name)
        });
        state.memoryContext = refreshedContext.fragments;
        state.memoryRecall = null;
        state.selectedSkillContext = refreshedContext.fragments.filter(
          (fragment) => fragment.scope === "skill_ref"
        );
        state.turnProviderMessages = rebuildTurnProviderMessages(messages, state.turnProviderMessages);
        const postCompactTokens = messages.reduce(
          (sum, message) => sum + estimateConversationMessageTokens(message),
          0
        );
        state.compactCooldownRemaining = resolveCompactCooldown({
          cooldownIterations: this.dependencies.compactCooldownIterations ?? 2,
          postCompactTokens,
          tokenThreshold: compactInputBase.tokenThreshold
        });
      } else if (state.compactCooldownRemaining > 0) {
        state.compactCooldownRemaining -= 1;
      }
    }

    if (state.completionVerificationSatisfied) {
      const lastAssistant = [...messages]
        .reverse()
        .find((message) => message.role === "assistant" && (message.content ?? "").trim().length > 0);
      const finalOutput =
        lastAssistant?.content.trim() ||
        "Workspace changes were verified before the iteration limit was reached.";
      return this.callbacks.completeTaskSuccess(state, messages, availableTools, task, finalOutput);
    }

    this.dependencies.traceService.record({
      actor: "runtime.kernel", eventType: "iteration_exhausted",
      payload: { iteration: state.maxIterations, maxIterations: state.maxIterations },
      stage: "control", summary: "Task reached its iteration limit without a final response",
      taskId: task.taskId
    });

    return this.callbacks.requestFinalSummaryWithoutTools(
      state,
      messages,
      availableTools,
      task,
      state.maxIterations,
      "max_iterations_exhausted"
    );
  }
}
