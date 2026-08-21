import {
  createToolFeedbackMessage,
  emitTaskEvent,
  safeSerializeToolOutputForBudget,
  summarizeToolOutput,
  toolCallSignature
} from "../kernel-support.js";
import { isSuccessfulVerificationToolCall as isSuccessfulVerificationToolExecution } from "./completion-controller.js";
import type { ExecutionLoopState } from "./execution-loop-state.js";
import { buildToolTaskMetadata } from "./tool-call-metadata.js";
import { toolResultOutputForModel } from "./tool-result-model.js";
import {
  recordRecentFileReadFromToolCall,
  type ContextRetentionConfig
} from "../context/recent-file-reads.js";
import { applyToolOutputBudget } from "../context/tool-output-budget.js";
import type {
  ConversationMessage,
  JsonValue,
  ProviderToolCall,
  RuntimeRunResult,
  TaskRecord,
  ToolExecutionResult
} from "../../types/index.js";
import type { ToolOrchestrator, ToolExecutionOutcome } from "../../tools/index.js";
import type { TraceService } from "../../tracing/trace-service.js";
import type { TaskRepository } from "../../types/index.js";
import type { CheckpointManager } from "./checkpoint-manager.js";

export interface ToolBatchExecutorDependencies {
  checkpointManager: CheckpointManager;
  contextRetention?: ContextRetentionConfig;
  taskRepository: TaskRepository;
  testCommands?: string[];
  toolOrchestrator: ToolOrchestrator;
  traceService: TraceService;
  workspaceRoot: string;
}

export class ToolBatchExecutor {
  public constructor(private readonly dependencies: ToolBatchExecutorDependencies) {}

  public async executeParallelToolBatch(
    state: ExecutionLoopState,
    messages: ConversationMessage[],
    pendingToolCalls: ProviderToolCall[],
    batchCalls: ProviderToolCall[],
    batchStartIndex: number,
    task: TaskRecord,
    iteration: number
  ): Promise<{ kind: "done"; toolCallCount: number } | { kind: "paused"; result: RuntimeRunResult }> {
    const clearedCalls: ProviderToolCall[] = [];
    const preflightOutcomes: Array<{ outcome: ToolExecutionOutcome; toolCall: ProviderToolCall }> = [];

    for (let batchOffset = 0; batchOffset < batchCalls.length; batchOffset += 1) {
      const toolCall = batchCalls[batchOffset];
      if (toolCall === undefined) {
        continue;
      }
      const invocation = await this.preflightToolCall(state, task, iteration, toolCall);
      const paused = this.tryPauseToolExecution(
        state,
        messages,
        pendingToolCalls,
        batchStartIndex + batchOffset,
        task,
        iteration,
        invocation
      );
      if (paused !== null) {
        for (const prior of preflightOutcomes) {
          if (prior.outcome.kind === "completed") {
            this.applyCompletedToolCallOutcome(
              state,
              messages,
              task,
              iteration,
              prior.toolCall,
              prior.outcome
            );
          }
        }
        return { kind: "paused", result: paused };
      }
      if (invocation.outcome.kind === "completed") {
        this.applyCompletedToolCallOutcome(
          state,
          messages,
          task,
          iteration,
          invocation.toolCall,
          invocation.outcome
        );
        preflightOutcomes.push(invocation);
        continue;
      }
      if (invocation.outcome.kind === "cleared") {
        clearedCalls.push(toolCall);
        continue;
      }
    }

    if (clearedCalls.length === 0) {
      return { kind: "done", toolCallCount: preflightOutcomes.length };
    }

    const batchInvocations = await Promise.all(
      clearedCalls.map(async (toolCall) => {
        const replayed = this.tryApplyDuplicateToolReplay(state, messages, task, iteration, toolCall);
        if (replayed) {
          return null;
        }
        return this.invokeToolCall(state, task, iteration, toolCall);
      })
    );

    let toolCallCount = preflightOutcomes.length;
    for (let batchOffset = 0; batchOffset < batchInvocations.length; batchOffset += 1) {
      const invocation = batchInvocations[batchOffset];
      if (invocation === null || invocation === undefined) {
        if (invocation === null) {
          toolCallCount += 1;
        }
        continue;
      }
      const paused = this.tryPauseToolExecution(
        state,
        messages,
        pendingToolCalls,
        batchStartIndex + clearedCalls.findIndex((call) => call.toolCallId === invocation.toolCall.toolCallId),
        task,
        iteration,
        invocation
      );
      if (paused !== null) {
        for (let priorOffset = 0; priorOffset < batchOffset; priorOffset += 1) {
          const priorInvocation = batchInvocations[priorOffset];
          if (priorInvocation === null || priorInvocation === undefined) {
            continue;
          }
          this.applyCompletedToolCallOutcome(
            state,
            messages,
            task,
            iteration,
            priorInvocation.toolCall,
            priorInvocation.outcome
          );
          toolCallCount += 1;
        }
        return { kind: "paused", result: paused };
      }
      this.applyCompletedToolCallOutcome(
        state,
        messages,
        task,
        iteration,
        invocation.toolCall,
        invocation.outcome
      );
      toolCallCount += 1;
    }

    return { kind: "done", toolCallCount };
  }

  public async preflightToolCall(
    state: ExecutionLoopState,
    task: TaskRecord,
    iteration: number,
    toolCall: ProviderToolCall
  ): Promise<{ outcome: ToolExecutionOutcome; toolCall: ProviderToolCall }> {
    const replayOutcome = this.resolveDuplicateToolReplay(state, toolCall);
    if (replayOutcome !== null) {
      emitTaskEvent(state.onTaskEvent, {
        iteration,
        kind: "tool",
        status: "started",
        taskId: task.taskId,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName
      });
      this.recordDuplicateToolReplayTrace(state, task, iteration, toolCall, replayOutcome);
      return { outcome: replayOutcome, toolCall };
    }

    emitTaskEvent(state.onTaskEvent, {
      iteration,
      kind: "tool",
      status: "started",
      taskId: task.taskId,
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName
    });
    state.managedAbortController.touchActivity("tool_call_preflight");

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
        governanceOnly: true,
        iteration,
        signal: state.managedAbortController.abortController.signal,
        taskId: task.taskId,
        taskMetadata: buildToolTaskMetadata(task),
        userId: task.requesterUserId,
        workspaceRoot: this.dependencies.workspaceRoot
      }
    );
    state.managedAbortController.touchActivity(`tool_call_preflight_${outcome.kind}`);

    return { outcome, toolCall };
  }

  public async invokeToolCall(
    state: ExecutionLoopState,
    task: TaskRecord,
    iteration: number,
    toolCall: ProviderToolCall
  ): Promise<{ outcome: ToolExecutionOutcome; toolCall: ProviderToolCall }> {
    const replayOutcome = this.resolveDuplicateToolReplay(state, toolCall);
    if (replayOutcome !== null) {
      emitTaskEvent(state.onTaskEvent, {
        iteration,
        kind: "tool",
        status: "started",
        taskId: task.taskId,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName
      });
      this.recordDuplicateToolReplayTrace(state, task, iteration, toolCall, replayOutcome);
      return { outcome: replayOutcome, toolCall };
    }

    emitTaskEvent(state.onTaskEvent, {
      iteration,
      kind: "tool",
      status: "started",
      taskId: task.taskId,
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName
    });
    state.managedAbortController.touchActivity("tool_call_started");

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
        taskMetadata: buildToolTaskMetadata(task),
        userId: task.requesterUserId,
        workspaceRoot: this.dependencies.workspaceRoot
      }
    );
    state.managedAbortController.touchActivity(`tool_call_${outcome.kind}`);

    return { outcome, toolCall };
  }

  public tryPauseToolExecution(
    state: ExecutionLoopState,
    messages: ConversationMessage[],
    pendingToolCalls: ProviderToolCall[],
    checkpointIndex: number,
    task: TaskRecord,
    iteration: number,
    invocation: { outcome: ToolExecutionOutcome; toolCall: ProviderToolCall }
  ): RuntimeRunResult | null {
    const { outcome, toolCall } = invocation;

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
      this.dependencies.checkpointManager.save({
        iteration,
        memoryContext: state.memoryContext,
        messages,
        pendingToolCalls: pendingToolCalls.slice(checkpointIndex),
        pendingClarifyPromptId: null,
        taskId: task.taskId
      });

      return {
        output: null,
        task
      };
    }

    if (outcome.kind === "clarify_required") {
      task = this.dependencies.taskRepository.update(task.taskId, {
        status: "waiting_clarification"
      });

      emitTaskEvent(state.onTaskEvent, {
        iteration,
        kind: "tool",
        status: "clarify_required",
        taskId: task.taskId,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName
      });
      this.dependencies.checkpointManager.save({
        iteration,
        memoryContext: state.memoryContext,
        messages,
        pendingClarifyPromptId: outcome.prompt.promptId,
        pendingToolCalls: pendingToolCalls.slice(checkpointIndex),
        taskId: task.taskId
      });

      return {
        output: null,
        task
      };
    }

    return null;
  }

  public applyCompletedToolCallOutcome(
    state: ExecutionLoopState,
    messages: ConversationMessage[],
    task: TaskRecord,
    iteration: number,
    toolCall: ProviderToolCall,
    outcome: ToolExecutionOutcome
  ): void {
    if (outcome.kind !== "completed") {
      const toolDescriptor = this.dependencies.toolOrchestrator.describeTool(toolCall.toolName);
      const privacyLevel = toolDescriptor?.privacyLevel ?? "internal";
      if (toolDescriptor?.capability !== "interaction.ask_user") {
        messages.push(
          createToolFeedbackMessage(
            {
              error: `Tool execution did not complete (${outcome.kind}).`,
              errorCode: `tool_${outcome.kind}`,
              recoverable: true
            },
            toolCall,
            privacyLevel
          )
        );
      }
      this.dependencies.traceService.record({
        actor: "runtime.tooling", eventType: "tool_execution_failed",
        payload: { iteration, outcomeKind: outcome.kind, toolCallId: toolCall.toolCallId, toolName: toolCall.toolName },
        stage: "tooling", summary: `Tool ${toolCall.toolName} did not complete`, taskId: task.taskId
      });

      emitTaskEvent(state.onTaskEvent, {
        iteration,
        kind: "tool",
        status: "failed",
        summary: `Tool ${toolCall.toolName} ended with ${outcome.kind}`,
        taskId: task.taskId,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName
      });
      return;
    }

    state.cumulativeToolCallCount += 1;
    if (!outcome.result.success && toolCall.toolName === "shell") {
      this.dependencies.traceService.record({ actor: "runtime.tooling", eventType: "environment_command_failed", payload: { iteration, toolCallId: toolCall.toolCallId, toolName: toolCall.toolName }, stage: "tooling", summary: "Environment command failed", taskId: task.taskId });
    }

    const toolDescriptor = this.dependencies.toolOrchestrator.describeTool(toolCall.toolName);
    const writeToolResult = isContentMutatingWrite(toolCall, toolDescriptor?.capability ?? null);
    if (
      outcome.result.success &&
      outcome.result.replayed !== true &&
      writeToolResult
    ) {
      state.writeToolSucceeded = true;
      state.completionVerificationSatisfied = false;
      if (state.recentFileReadCache !== null) {
        const keepPath = writeTargetPath(toolCall);
        if (keepPath !== null) {
          state.recentFileReadCache.retainMatching(keepPath);
        }
      }
    }
    if (outcome.result.success && outcome.result.replayed !== true && writeToolResult) {
      this.dependencies.traceService.record({ actor: "runtime.kernel", eventType: "completion_verification_pending", payload: { iteration, toolCallId: toolCall.toolCallId, toolName: toolCall.toolName }, stage: "completion", summary: "Workspace write requires subsequent verification", taskId: task.taskId });
    }
    if (
      isSuccessfulVerificationToolExecution(
        toolCall.toolName,
        outcome.result,
        this.dependencies.testCommands ?? []
      )
    ) {
      state.completionVerificationSatisfied = true;
      if (!state.completionVerificationSatisfiedEmitted) {
        this.dependencies.traceService.record({
          actor: "runtime.kernel",
          eventType: "completion_verification_satisfied",
          payload: {
            iteration,
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName
          },
          stage: "completion",
          summary: "Completion verification evidence recorded",
          taskId: task.taskId
        });
        state.completionVerificationSatisfiedEmitted = true;
      }
    }
    const toolResultOutput = toolResultOutputForModel(outcome.result);
    if (state.recentFileReadCache !== null && outcome.result.success) {
      recordRecentFileReadFromToolCall(
        state.recentFileReadCache,
        toolCall.toolName,
        toolCall.input as { path?: unknown },
        toolResultOutput,
        toolCall.toolCallId
      );
    }
    const toolSummary = toolResultSummary(outcome.result, toolCall.toolName);
    const structuredOutputSummary = summarizeToolOutput(toolResultOutput);
    const isDeduplicatable =
      toolDescriptor !== null &&
      (toolDescriptor.capability === "filesystem.read" ||
        toolDescriptor.capability === "network.fetch_public_readonly");
    const signature = isDeduplicatable
      ? toolCallSignature(toolCall.toolName, toolCall.input)
      : null;
    const priorCall =
      signature === null ? null : state.toolCallSignatures.get(signature) ?? null;
    const duplicateNotice =
      priorCall === null
        ? null
        : `NOTE: duplicate tool call. You already invoked ${toolCall.toolName} with identical arguments at iteration ${priorCall.iteration} (call ${priorCall.toolCallId}). Do not call this tool again with the same arguments - synthesize from the prior result and answer the user.`;
    const finishedSummary =
      priorCall === null
        ? `${toolSummary} | ${structuredOutputSummary}`
        : `${toolSummary} | ${structuredOutputSummary} (duplicate of iter ${priorCall.iteration})`;
    const privacyLevel = toolDescriptor?.privacyLevel ?? "internal";

    if (toolDescriptor !== null) {
      if (toolDescriptor.capability !== "interaction.ask_user") {
        const feedbackMessage = this.buildToolFeedbackMessage(
          state,
          task,
          toolCall,
          toolResultOutput,
          privacyLevel,
          duplicateNotice
        );
        messages.push(feedbackMessage);
        if (signature !== null && priorCall === null) {
          state.toolCallSignatures.set(signature, {
            cachedToolOutput: safeSerializeToolOutputForBudget(toolResultOutput),
            iteration,
            toolCallId: toolCall.toolCallId
          });
        }
      }
      if (signature !== null && priorCall === null && toolDescriptor.capability === "interaction.ask_user") {
        state.toolCallSignatures.set(signature, {
          iteration,
          toolCallId: toolCall.toolCallId
        });
      }
      emitTaskEvent(state.onTaskEvent, {
        iteration,
        kind: "tool",
        status: outcome.result.success ? "finished" : "failed",
        summary: finishedSummary,
        taskId: task.taskId,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName
      });
      return;
    }
    const feedbackMessage = this.buildToolFeedbackMessage(
      state,
      task,
      toolCall,
      toolResultOutput,
      privacyLevel,
      duplicateNotice
    );
    messages.push(feedbackMessage);
    if (signature !== null && priorCall === null) {
      state.toolCallSignatures.set(signature, {
        cachedToolOutput: safeSerializeToolOutputForBudget(toolResultOutput),
        iteration,
        toolCallId: toolCall.toolCallId
      });
    }
    emitTaskEvent(state.onTaskEvent, {
      iteration,
      kind: "tool",
      status: outcome.result.success ? "finished" : "failed",
      summary: finishedSummary,
      taskId: task.taskId,
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName
    });
  }

  public tryApplyDuplicateToolReplay(
    state: ExecutionLoopState,
    messages: ConversationMessage[],
    task: TaskRecord,
    iteration: number,
    toolCall: ProviderToolCall
  ): boolean {
    const replayOutcome = this.resolveDuplicateToolReplay(state, toolCall);
    if (replayOutcome === null) {
      return false;
    }

    emitTaskEvent(state.onTaskEvent, {
      iteration,
      kind: "tool",
      status: "started",
      taskId: task.taskId,
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName
    });
    this.applyCompletedToolCallOutcome(
      state,
      messages,
      task,
      iteration,
      toolCall,
      replayOutcome
    );
    this.recordDuplicateToolReplayTrace(state, task, iteration, toolCall, replayOutcome);
    return true;
  }

  private resolveDuplicateToolReplay(
    state: ExecutionLoopState,
    toolCall: ProviderToolCall
  ): Extract<ToolExecutionOutcome, { kind: "completed" }> | null {
    const toolDescriptor = this.dependencies.toolOrchestrator.describeTool(toolCall.toolName);
    const isDeduplicatable =
      toolDescriptor !== null &&
      (toolDescriptor.capability === "filesystem.read" ||
        toolDescriptor.capability === "network.fetch_public_readonly");
    if (!isDeduplicatable) {
      return null;
    }
    const signature = toolCallSignature(toolCall.toolName, toolCall.input);
    const priorCall = state.toolCallSignatures.get(signature);
    if (priorCall === undefined || priorCall.cachedToolOutput === undefined) {
      return null;
    }

    let parsedOutput: unknown = priorCall.cachedToolOutput;
    try {
      parsedOutput = JSON.parse(priorCall.cachedToolOutput);
    } catch {
      parsedOutput = priorCall.cachedToolOutput;
    }

    return {
      kind: "completed",
      result: {
        output: parsedOutput as JsonValue,
        replayed: true,
        success: true,
        summary: `Tool ${toolCall.toolName} replayed from duplicate cache`
      },
      toolCall: {
        errorCode: null,
        errorMessage: null,
        finishedAt: new Date().toISOString(),
        input: toolCall.input,
        iteration: state.task.currentIteration,
        output: parsedOutput as JsonValue,
        requestedAt: new Date().toISOString(),
        riskLevel: toolDescriptor?.riskLevel ?? "low",
        startedAt: new Date().toISOString(),
        status: "finished",
        summary: `Tool ${toolCall.toolName} replayed from duplicate cache`,
        taskId: state.task.taskId,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName
      }
    };
  }

  private recordDuplicateToolReplayTrace(
    state: ExecutionLoopState,
    task: TaskRecord,
    iteration: number,
    toolCall: ProviderToolCall,
    replayOutcome: Extract<ToolExecutionOutcome, { kind: "completed" }>
  ): void {
    const signature = toolCallSignature(toolCall.toolName, toolCall.input);
    const priorCall = state.toolCallSignatures.get(signature);
    this.dependencies.traceService.record({
      actor: "runtime.kernel",
      eventType: "duplicate_tool_replayed",
      payload: {
        iteration,
        priorIteration: priorCall?.iteration ?? null,
        priorToolCallId: priorCall?.toolCallId ?? null,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName
      },
      stage: "tooling",
      summary: `Replayed duplicate ${toolCall.toolName} from iteration ${priorCall?.iteration ?? "unknown"}`,
      taskId: task.taskId
    });
    void replayOutcome;
    void state;
  }

  private buildToolFeedbackMessage(
    state: ExecutionLoopState,
    task: TaskRecord,
    toolCall: ProviderToolCall,
    toolResultOutput: unknown,
    privacyLevel: "public" | "internal" | "restricted",
    duplicateNotice: string | null
  ): ConversationMessage {
    const serialized = safeSerializeToolOutputForBudget(toolResultOutput);
    const maxTokens = this.dependencies.contextRetention?.toolOutputMaxTokens ?? 2_500;
    const budgeted = applyToolOutputBudget(
      {
        serialized,
        taskId: task.taskId,
        toolCallId: toolCall.toolCallId
      },
      {
        artifactsRoot: state.toolArtifactsRoot,
        maxTokensPerResult: maxTokens
      }
    );
    const base = createToolFeedbackMessage(
      toolResultOutput,
      toolCall,
      privacyLevel,
      budgeted.content
    );
    if (duplicateNotice === null) {
      return base;
    }
    return {
      ...base,
      content: `${duplicateNotice}\n\n${base.content}`
    };
  }
}

function toolResultSummary(result: ToolExecutionResult, toolName: string): string {
  return result.success
    ? result.summary
    : `Tool ${toolName} failed: ${result.errorMessage}`;
}

/**
 * Content-mutating writes require verification. Deleting temporary files via
 * patch delete_file must not reset verification or mark the workspace as mutated.
 */
export function isContentMutatingWrite(
  toolCall: ProviderToolCall,
  capability: string | null
): boolean {
  const looksLikeWrite =
    capability === "filesystem.write" || toolCall.toolName.includes("write");
  if (!looksLikeWrite) {
    return false;
  }
  if (toolCall.toolName === "patch") {
    const action = (toolCall.input as { action?: unknown }).action;
    if (action === "delete_file") {
      return false;
    }
  }
  return true;
}

export function writeTargetPath(toolCall: ProviderToolCall): string | null {
  const input = toolCall.input as { action?: unknown; path?: unknown; toPath?: unknown };
  if (input.action === "rename_file" && typeof input.toPath === "string" && input.toPath.trim().length > 0) {
    return input.toPath.trim();
  }
  if (typeof input.path === "string" && input.path.trim().length > 0) {
    return input.path.trim();
  }
  return null;
}
