import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { createManagedAbortController } from "./abort-controller.js";
import { AppError, toAppError } from "./app-error.js";
import { ExecutionContextAssembler } from "./context-assembler.js";
import {
  buildFinalSessionCompactInput,
  emitTaskEvent,
  injectResumeContextMessages,
  providerUsageToJson,
  readSessionResumeMemoryContext,
  readSessionResumeMessages,
  readSessionResumePriorTaskId,
  summarizeText,
  toConversationRole
} from "./kernel-support.js";
import {
  BudgetRecorder,
  CheckpointManager,
  CompletionController,
  ExecutionLoopRunner,
  type ExecutionLoopState,
  ToolBatchExecutor,
  buildToolExposurePlannerInput,
  buildToolTaskMetadata
} from "./kernel/index.js";
import { buildRepoMap } from "./repo-map.js";
import {
  RecentFileReadCache,
  formatRecentlyReadFilesSummary
} from "./context/recent-file-reads.js";
import type { ContextRetentionConfig } from "./context/recent-file-reads.js";
import {
  resolveTodoSessionKeyFromTaskMetadata,
  syncSessionTodosMessage
} from "./context/session-todos.js";
import { PRIOR_TASK_RESULT_SOURCE_TYPE } from "./sessions/prior-task-context.js";
import type { ContextCompactor, SessionSummaryService } from "./context/index.js";
import {
  computeCompactThreshold,
  computePromptTokens,
  createHybridTokenCounterState
} from "./context/token-counter.js";

import { buildSessionHandoffMessageContent, listDiscardedMessages } from "./context/compact-handoff.js";
import type { ManualCompactRequest } from "./context/manual-compact-coordinator.js";
import { selectTailMessages } from "./context/tail-selector.js";
import type { RecallPlanner } from "./retrieval/index.js";
import type { RetrievalWorker, SummarizerWorker, WorkerDispatcher } from "./workers/index.js";
import type { RuntimeConfig, WorkflowRuntimeConfig, InteractionModesRuntimeConfig } from "./runtime-config.js";
import type { ToolExposurePlanner } from "./tool-exposure-planner.js";
import type { ProviderRouter } from "../providers/routing/provider-router.js";
import type { AuxiliaryProviderResolver } from "../providers/auxiliary-resolver.js";
import {
  isAcceptableUserFinalText,
  resolveProviderFinalText
} from "../providers/reasoning-content.js";
import { generateWithProviderFailover } from "../providers/provider-failover.js";
import type { AgentProfileRegistry } from "../profiles/agent-profile-registry.js";
import type { AuditService } from "../audit/audit-service.js";
import type {
  ConversationMessage,
  ExecutionCheckpointRepository,
  Provider,
  ProviderResponse,
  ProviderToolDescriptor,
  ProviderToolCall,
  RuntimeOutputEvent,
  RuntimeTaskEvent,
  RunMetadataRepository,
  RuntimeRunOptions,
  RuntimeRunResult,
  SessionCompactResult,
  SessionTranscriptRepository,
  TaskRecord,
  TaskRepository,
  SessionCommitmentState,
  SessionLineageRepository,
  SessionMessageRepository,
  SessionTaskRepository,
  SessionEntrySource,
  BudgetPricingEntry
} from "../types/index.js";
import type { MemoryPlane } from "../memory/memory-plane.js";
import type { MemoryFlushService } from "../memory/memory-flush-service.js";
import type { MemoryBackgroundReviewService } from "../memory/memory-background-review-service.js";
import {
  DeterministicCompactSummarizer,
  type CompactSummarizer,
  ProviderSubagentSummarizer
} from "../memory/compact-summarizer.js";
import type { CompactTriggerPolicy } from "../memory/compact-policy.js";
import type { WebSearchBackend } from "../core/web-search-config.js";
import type { ToolOrchestrator } from "../tools/index.js";
import type { TraceService } from "../tracing/trace-service.js";
import type { BudgetService } from "./budget/budget-service.js";
import type { RuntimeOutputService } from "./runtime-output-service.js";
import type { SessionMessageProjector } from "./sessions/session-message-projector.js";
import { pinUserMessagesFromRecords } from "./sessions/session-user-message-pin.js";
import type { SkillContextService } from "../skills/index.js";
import type { ManualCompactCoordinator } from "./context/manual-compact-coordinator.js";
import type { TodoItem, TodoSessionStore } from "../tools/todo-session-store.js";

export interface ExecutionKernelDependencies {
  agentProfileRegistry: AgentProfileRegistry;
  auditService: AuditService;
  auxiliaryProviderResolver?: AuxiliaryProviderResolver;
  compactPolicy: CompactTriggerPolicy;
  executionCheckpointRepository: ExecutionCheckpointRepository;
  getSessionCommitmentState?: (sessionId: string) => SessionCommitmentState | null;
  manualCompactCoordinator?: ManualCompactCoordinator;
  memoryPlane: MemoryPlane;
  memoryFlushService?: MemoryFlushService;
  memoryBackgroundReviewService?: MemoryBackgroundReviewService;
  recallPlanner: RecallPlanner;
  provider: Provider;
  runMetadataRepository: RunMetadataRepository;
  runtimeVersion: string;
  taskRepository: TaskRepository;
  sessionTaskRepository: SessionTaskRepository;
  sessionLineageRepository: SessionLineageRepository;
  sessionMessageRepository?: SessionMessageRepository;
  sessionTranscriptRepository: SessionTranscriptRepository;
  sessionMessageProjector?: SessionMessageProjector;
  contextCompactor: ContextCompactor;
  sessionSummaryService: SessionSummaryService;
  toolOrchestrator: ToolOrchestrator;
  traceService: TraceService;
  outputService: RuntimeOutputService;
  workflow: WorkflowRuntimeConfig;
  compact: RuntimeConfig["compact"];
  contextRetention?: ContextRetentionConfig;
  budgetPricing?: Record<string, BudgetPricingEntry>;
  budgetService?: BudgetService;
  workerDispatcher?: WorkerDispatcher;
  summarizerWorker?: SummarizerWorker;
  retrievalWorker?: RetrievalWorker;
  providerRouter?: ProviderRouter;
  routingMode?: "cheap_first" | "balanced" | "quality_first";
  toolExposurePlanner?: ToolExposurePlanner;
  skillContextService?: SkillContextService;
  todoSessionStore?: TodoSessionStore;
  interactionModes: InteractionModesRuntimeConfig;
  webSearchBackend: WebSearchBackend;
  workspaceRoot: string;
}

export class ExecutionKernel {
  private readonly contextAssembler = new ExecutionContextAssembler();
  private readonly budgetRecorder: BudgetRecorder;
  private readonly checkpointManager: CheckpointManager;
  private readonly completionController: CompletionController;
  private readonly toolBatchExecutor: ToolBatchExecutor;
  private readonly executionLoopRunner: ExecutionLoopRunner;

  public constructor(private readonly dependencies: ExecutionKernelDependencies) {
    this.budgetRecorder = new BudgetRecorder({
      mode: dependencies.routingMode ?? "balanced",
      recordTrace: (event) => dependencies.traceService.record(event),
      taskRepository: dependencies.taskRepository,
      ...(dependencies.budgetPricing !== undefined
        ? { budgetPricing: dependencies.budgetPricing }
        : {}),
      ...(dependencies.budgetService !== undefined
        ? { budgetService: dependencies.budgetService }
        : {})
    });
    this.checkpointManager = new CheckpointManager({
      executionCheckpointRepository: dependencies.executionCheckpointRepository,
      toolOrchestrator: dependencies.toolOrchestrator
    });
    this.completionController = new CompletionController({
      describeTool: (toolName) => dependencies.toolOrchestrator.describeTool(toolName),
      recordTrace: (event) => dependencies.traceService.record(event),
      testCommands: formatWorkflowTestCommandHints(dependencies.workflow.testCommands)
    });
    this.toolBatchExecutor = new ToolBatchExecutor({
      checkpointManager: this.checkpointManager,
      taskRepository: dependencies.taskRepository,
      testCommands: formatWorkflowTestCommandHints(dependencies.workflow.testCommands),
      toolOrchestrator: dependencies.toolOrchestrator,
      traceService: dependencies.traceService,
      workspaceRoot: dependencies.workspaceRoot,
      ...(dependencies.contextRetention !== undefined
        ? { contextRetention: dependencies.contextRetention }
        : {})
    });
    this.executionLoopRunner = new ExecutionLoopRunner(
      {
        auditService: dependencies.auditService,
        budgetRecorder: this.budgetRecorder,
        checkpointManager: this.checkpointManager,
        completionController: this.completionController,
        contextAssembler: this.contextAssembler,
        contextCompactor: dependencies.contextCompactor,
        provider: dependencies.provider,
        sessionLineageRepository: dependencies.sessionLineageRepository,
        sessionSummaryService: dependencies.sessionSummaryService,
        sessionTaskRepository: dependencies.sessionTaskRepository,
        taskRepository: dependencies.taskRepository,
        toolBatchExecutor: this.toolBatchExecutor,
        toolOrchestrator: dependencies.toolOrchestrator,
        traceService: dependencies.traceService,
        workspaceRoot: dependencies.workspaceRoot,
        compactCooldownIterations: dependencies.compact.compactCooldownIterations,
        ...(dependencies.contextRetention !== undefined
          ? { toolResultKeepGroups: dependencies.contextRetention.toolResultKeepGroups }
          : {}),
        ...(dependencies.getSessionCommitmentState !== undefined
          ? { getSessionCommitmentState: dependencies.getSessionCommitmentState }
          : {}),
        ...(dependencies.manualCompactCoordinator !== undefined
          ? { manualCompactCoordinator: dependencies.manualCompactCoordinator }
          : {}),
        ...(dependencies.summarizerWorker !== undefined
          ? { summarizerWorker: dependencies.summarizerWorker }
          : {}),
        ...(dependencies.toolExposurePlanner !== undefined
          ? { toolExposurePlanner: dependencies.toolExposurePlanner }
          : {}),
        ...(dependencies.workerDispatcher !== undefined
          ? { workerDispatcher: dependencies.workerDispatcher }
          : {})
      },
      {
        buildCompactInput: (input) => this.buildCompactInput(input),
        compactMessages: (input, manualRequest) => this.compactMessages(input, manualRequest),
        shouldCompact: (input) => this.dependencies.compactPolicy.shouldCompact(input).triggered,
        completeTaskSuccess: (state, messages, availableTools, task, finalOutput) =>
          this.completeTaskSuccess(state, messages, availableTools, task, finalOutput),
        emitOutput: (draft) => this.emitOutput(draft),
        ...(dependencies.memoryFlushService !== undefined
          ? { flushMemory: (input: Parameters<MemoryFlushService["flush"]>[0]) => dependencies.memoryFlushService?.flush(input) ?? Promise.resolve(0) }
          : {}),
        planRecall: (input) => this.planRecall(input),
        requestFinalSummaryWithoutTools: (state, messages, availableTools, task, iteration, reason) =>
          this.requestFinalSummaryWithoutTools(
            state,
            messages,
            availableTools,
            task,
            iteration,
            reason
          ),
        resolveActiveMainProvider: (task) => this.resolveActiveMainProvider(task),
        resolvePinnedUserMessages: (sessionId) => this.resolvePinnedUserMessages(sessionId),
        resolveSessionTodos: (sessionId) => this.resolveSessionTodos(sessionId),
        syncRecentFileCacheMode: (state, pendingToolCalls, availableTools) =>
          this.syncRecentFileCacheMode(state, pendingToolCalls, availableTools),
        syncSessionTodosContext: (input) => this.syncSessionTodosContext(input)
      }
    );
  }

  public setPrimaryProvider(provider: Provider): void {
    this.dependencies.provider = provider;
  }

  private resolveActiveMainProvider(task: TaskRecord): Provider {
    const routed = this.dependencies.providerRouter?.selectProvider({
      kind: "main",
      taskId: task.taskId,
      sessionId: task.sessionId ?? null,
      ...(this.dependencies.routingMode !== undefined
        ? { mode: this.dependencies.routingMode }
        : {})
    });
    return routed?.provider ?? this.dependencies.provider;
  }

  private syncSessionTodosContext(input: {
    iteration?: number;
    messages: ConversationMessage[];
    task: TaskRecord;
  }): { todoCount: number } | null {
    const store = this.dependencies.todoSessionStore;
    if (store === undefined) {
      return null;
    }
    const sessionKey = resolveTodoSessionKeyFromTaskMetadata({
      ...(input.task.sessionId !== undefined ? { sessionId: input.task.sessionId } : {}),
      taskId: input.task.taskId,
      taskMetadata: input.task.metadata
    });
    const injected = syncSessionTodosMessage(input.messages, store, sessionKey);
    if (injected === null) {
      return null;
    }
    const todoCount = store.get(sessionKey).length;
    return { todoCount };
  }

  private async planRecall(
    input: Parameters<RecallPlanner["plan"]>[0]
  ): Promise<ReturnType<RecallPlanner["plan"]>> {
    const workerDispatcher = this.dependencies.workerDispatcher;
    const retrievalWorker = this.dependencies.retrievalWorker;
    if (workerDispatcher === undefined || retrievalWorker === undefined) {
      return this.dependencies.recallPlanner.plan(input);
    }
    const result = await workerDispatcher.dispatch(
      {
        backoffBaseMs: 150,
        backoffMaxMs: 1_000,
        input,
        maxAttempts: 2,
        taskId: input.task.taskId,
        sessionId: input.task.sessionId ?? null,
        timeoutMs: 5_000,
        workerId: randomUUID(),
        workerKind: "retrieval"
      },
      (request) => retrievalWorker.execute(request)
    );
    if (result.output !== null) {
      return result.output;
    }
    return this.dependencies.recallPlanner.plan(input);
  }

  public async run(options: RuntimeRunOptions): Promise<RuntimeRunResult> {
    const taskId = options.taskId ?? randomUUID();
    const explicitSkillMetadata = this.buildExplicitSkillMetadata(options.taskInput);
    const taskMetadata = {
      ...(options.metadata ?? {}),
      ...explicitSkillMetadata,
      ...(options.interactionMode !== undefined ? { interactionMode: options.interactionMode } : {}),
      agentWriteApproval: this.dependencies.interactionModes.agentWriteApproval
    };
    let task = this.dependencies.taskRepository.create({
      agentProfileId: options.agentProfileId,
      cwd: options.cwd,
      input: options.taskInput,
      maxIterations: options.maxIterations,
      metadata: taskMetadata,
      providerName: this.dependencies.provider.name,
      requesterUserId: options.userId,
      taskId,
      sessionId: options.sessionId ?? null,
      tokenBudget: options.tokenBudget
    });
    if (options.sessionId !== undefined && options.sessionId !== null) {
      this.supersedeStaleSessionTasks(options.sessionId, taskId);
    }
    const stopOutputSubscription =
      options.onOutputEvent === undefined
        ? null
        : this.dependencies.outputService.subscribe((event) => {
            if (event.taskId === taskId) {
              options.onOutputEvent?.(event);
            }
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
    this.emitOutput({
      eventType: "task_input",
      payload: { input: options.taskInput },
      stage: "planning",
      taskId
    });
    this.appendSessionTranscript(task, {
      content: options.taskInput,
      eventType: "user_message",
      payload: {
        source: "task_input"
      },
      role: "user"
    });

    this.dependencies.runMetadataRepository.create({
      agentProfileId: options.agentProfileId,
      createdAt: new Date().toISOString(),
      metadata: taskMetadata,
      providerName: this.dependencies.provider.name,
      requesterUserId: options.userId,
      runMetadataId: randomUUID(),
      runtimeVersion: this.dependencies.runtimeVersion,
      taskId,
      timeoutMs: options.timeoutMs,
      tokenBudget: options.tokenBudget,
      workspaceRoot: this.dependencies.workspaceRoot
    });

    const timeoutMode = options.timeoutMode ?? "wall_clock";
    const managedAbortController = createManagedAbortController(options.timeoutMs, options.signal, {
      mode: timeoutMode,
      onInactivityWarning: (details) => {
        this.emitOutput({
          eventType: "provider_status",
          payload: {
            kind: "inactivity_warning",
            message: "Task has been inactive for 75% of the timeout window.",
            modelName: this.dependencies.provider.model ?? null,
            providerName: this.dependencies.provider.name,
            reason: details.lastActivityReason ?? "no recent runtime activity"
          },
          stage: "planning",
          taskId
        });
      }
    });

    try {
      managedAbortController.touchActivity("task_started");
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
          timeoutMode,
          timeoutMs: options.timeoutMs
        },
        stage: "lifecycle",
        summary: "Task execution started",
        taskId
      });

      const profile = this.dependencies.agentProfileRegistry.get(options.agentProfileId);
      const sessionId = task.sessionId ?? null;
      const initialToolExposure = this.dependencies.toolExposurePlanner
        ? await this.dependencies.toolExposurePlanner.plan(
            buildToolExposurePlannerInput({
              context: {
                agentProfileId: options.agentProfileId,
                cwd: options.cwd,
                iteration: 1,
                signal: managedAbortController.abortController.signal,
                taskId,
                taskMetadata: buildToolTaskMetadata(task),
                userId: options.userId,
                workspaceRoot: this.dependencies.workspaceRoot
              },
              interactionMode: options.interactionMode,
              iteration: 1,
              taskId,
              sessionId
            })
          )
        : null;
      managedAbortController.touchActivity("tool_exposure_planned");
      const availableTools =
        initialToolExposure?.tools ?? this.dependencies.toolOrchestrator.listTools();
      const recallPlan = await this.planRecall({
        task,
        sessionCommitmentState:
          sessionId === null ? null : this.dependencies.getSessionCommitmentState?.(sessionId) ?? null,
        tokenBudget: options.tokenBudget,
        toolPlan: availableTools.map((tool) => tool.name)
      });
      managedAbortController.touchActivity("recall_planned");
      const repoMap = this.dependencies.workflow.repoMap.enabled
        ? buildRepoMap(this.dependencies.workspaceRoot)
        : null;
      managedAbortController.touchActivity("repo_map_created");
      const messages = this.contextAssembler.buildInitialMessages(
        task,
        availableTools,
        profile,
        repoMap?.summary,
        initialToolExposure?.decisions ?? [],
        options.interactionMode,
        { searchBackend: this.dependencies.webSearchBackend }
      );
      const resumeContextMessages = readSessionResumeMessages(taskMetadata);
      if (resumeContextMessages.length > 0) {
        injectResumeContextMessages(messages, resumeContextMessages);
        const priorTaskMessage = resumeContextMessages.find(
          (message) => message.metadata?.sourceType === PRIOR_TASK_RESULT_SOURCE_TYPE
        );
        if (priorTaskMessage !== undefined) {
          this.dependencies.traceService.record({
            actor: "runtime.context",
            eventType: "prior_task_context_injected",
            payload: {
              priorTaskId: readSessionResumePriorTaskId(taskMetadata) ?? "unknown",
              truncated: priorTaskMessage.content.includes("...[prior task output truncated]")
            },
            stage: "planning",
            summary: "Injected prior task final output into session continuation context",
            taskId
          });
        }
      }
      const resumeMemoryContext = readSessionResumeMemoryContext(taskMetadata);
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
        ...this.createContextLoopFields(),
        cwd: options.cwd,
        costWarnedToolNames: [],
        completionIntentSeenAt: null,
        completionVerificationGuardEmitted: false,
        completionVerificationSatisfied: false,
        completionVerificationSatisfiedEmitted: false,
        criticalBudgetPressureEmitted: false,
        cumulativeToolCallCount: 0,
        interactionMode: options.interactionMode,
        iterationsSinceLastCompact: 0,
        managedAbortController,
        maxIterations: options.maxIterations,
        memoryContext: [...recallPlan.fragments, ...resumeMemoryContext],
        memoryRecall: null,
        messages,
        ...(options.onAssistantTextDelta !== undefined
          ? { onAssistantTextDelta: options.onAssistantTextDelta }
          : {}),
        ...(options.onOutputEvent !== undefined ? { onOutputEvent: options.onOutputEvent } : {}),
        ...(options.onTaskEvent !== undefined ? { onTaskEvent: options.onTaskEvent } : {}),
        pendingToolCalls: [],
        postCompletionVerificationReads: 0,
        ...(repoMap?.summary !== undefined ? { repoMapSummary: repoMap.summary } : {}),
        readOnlyTurns: 0,
        selectedSkillContext: recallPlan.fragments.filter((fragment) => fragment.scope === "skill_ref"),
        silentToolTurns: 0,
        task,
        toolCallSignatures: new Map(),
        turnFilteredFragments: [],
        turnProviderMessages: messages,
        taskRecoveryUsed: false,
        tokenBudget: options.tokenBudget,
        warningBudgetPressureEmitted: false,
        writeToolSucceeded: false
      });
    } catch (error) {
      throw this.finalizeTaskFailure(task, toAppError(error), options.onTaskEvent);
    } finally {
      stopOutputSubscription?.();
      managedAbortController.dispose();
    }
  }

  public async resumeTask(
    taskId: string,
    options: { onOutputEvent?: (event: RuntimeOutputEvent) => void; signal?: AbortSignal } = {}
  ): Promise<RuntimeRunResult> {
    const task = this.dependencies.taskRepository.findById(taskId);
    if (task === null) {
      throw new AppError({
        code: "task_not_found",
        message: `Task ${taskId} was not found.`
      });
    }

    if (task.status !== "waiting_approval" && task.status !== "waiting_clarification") {
      throw new AppError({
        code: "task_not_resumable",
        message: `Task ${taskId} is not waiting for approval or clarification.`
      });
    }

    const resumeCheckpoint = this.checkpointManager.loadForResume(task);
    const checkpoint = resumeCheckpoint.checkpoint;

    const runMetadata = this.dependencies.runMetadataRepository.findByTaskId(taskId);
    if (runMetadata === null) {
      throw new AppError({
        code: "task_not_resumable",
        message: `Task ${taskId} has no run metadata to resume from.`
      });
    }

    const managedAbortController = createManagedAbortController(runMetadata.timeoutMs, options.signal);
    const stopOutputSubscription =
      options.onOutputEvent === undefined
        ? null
        : this.dependencies.outputService.subscribe((event) => {
            if (event.taskId === taskId) {
              options.onOutputEvent?.(event);
            }
          });
    let resumedTask = this.dependencies.taskRepository.update(taskId, {
      status: "running"
    });

    try {
      return await this.executeLoop({
        ...this.createContextLoopFields(),
        cwd: resumedTask.cwd,
        costWarnedToolNames: [],
        completionIntentSeenAt: null,
        completionVerificationGuardEmitted: false,
        completionVerificationSatisfied: false,
        completionVerificationSatisfiedEmitted: false,
        criticalBudgetPressureEmitted: false,
        cumulativeToolCallCount: 0,
        interactionMode: readInteractionModeFromMetadata(runMetadata.metadata),
        iterationsSinceLastCompact: 0,
        managedAbortController,
        maxIterations: resumedTask.maxIterations,
        memoryContext: checkpoint.memoryContext,
        memoryRecall: null,
        messages: checkpoint.messages,
        ...(options.onOutputEvent !== undefined ? { onOutputEvent: options.onOutputEvent } : {}),
        pendingToolCalls: checkpoint.pendingToolCalls,
        postCompletionVerificationReads: 0,
        readOnlyTurns: 0,
        selectedSkillContext: [],
        silentToolTurns: 0,
        task: resumedTask,
        taskRecoveryUsed: this.hasRecoveryBeenUsed(resumedTask.taskId),
        toolCallSignatures: resumeCheckpoint.toolCallSignatures,
        turnFilteredFragments: [],
        turnProviderMessages: checkpoint.messages,
        tokenBudget: resumedTask.tokenBudget,
        warningBudgetPressureEmitted: false,
        writeToolSucceeded: resumeCheckpoint.writeToolSucceeded
      });
    } catch (error) {
      resumedTask = this.dependencies.taskRepository.findById(taskId) ?? resumedTask;
      throw this.finalizeTaskFailure(resumedTask, toAppError(error));
    } finally {
      stopOutputSubscription?.();
      managedAbortController.dispose();
    }
  }

  public async resumeTaskAfterApprovalFailure(
    taskId: string,
    toolCallId: string,
    options: { onOutputEvent?: (event: RuntimeOutputEvent) => void; signal?: AbortSignal } = {}
  ): Promise<RuntimeRunResult> {
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

    const resumeCheckpoint = this.checkpointManager.loadForResume(task);
    const checkpoint = resumeCheckpoint.checkpoint;
    const rejectedToolCall = checkpoint.pendingToolCalls.find(
      (toolCall) => toolCall.toolCallId === toolCallId
    );
    if (rejectedToolCall === undefined) {
      throw new AppError({
        code: "task_not_resumable",
        message: `Task ${taskId} checkpoint has no pending tool call ${toolCallId}.`
      });
    }

    const runMetadata = this.dependencies.runMetadataRepository.findByTaskId(taskId);
    if (runMetadata === null) {
      throw new AppError({
        code: "task_not_resumable",
        message: `Task ${taskId} has no run metadata to resume from.`
      });
    }

    const managedAbortController = createManagedAbortController(runMetadata.timeoutMs, options.signal);
    const stopOutputSubscription =
      options.onOutputEvent === undefined
        ? null
        : this.dependencies.outputService.subscribe((event) => {
            if (event.taskId === taskId) {
              options.onOutputEvent?.(event);
            }
          });
    let resumedTask = this.dependencies.taskRepository.update(taskId, {
      status: "running"
    });

    try {
      return await this.executeLoop({
        ...this.createContextLoopFields(),
        cwd: resumedTask.cwd,
        costWarnedToolNames: [],
        completionIntentSeenAt: null,
        completionVerificationGuardEmitted: false,
        completionVerificationSatisfied: false,
        completionVerificationSatisfiedEmitted: false,
        criticalBudgetPressureEmitted: false,
        cumulativeToolCallCount: 0,
        interactionMode: readInteractionModeFromMetadata(runMetadata.metadata),
        iterationsSinceLastCompact: 0,
        managedAbortController,
        maxIterations: resumedTask.maxIterations,
        memoryContext: checkpoint.memoryContext,
        memoryRecall: null,
        messages: checkpoint.messages,
        ...(options.onOutputEvent !== undefined ? { onOutputEvent: options.onOutputEvent } : {}),
        pendingToolCalls: [rejectedToolCall],
        postCompletionVerificationReads: 0,
        readOnlyTurns: 0,
        selectedSkillContext: [],
        silentToolTurns: 0,
        task: resumedTask,
        taskRecoveryUsed: this.hasRecoveryBeenUsed(resumedTask.taskId),
        toolCallSignatures: resumeCheckpoint.toolCallSignatures,
        turnFilteredFragments: [],
        turnProviderMessages: checkpoint.messages,
        tokenBudget: resumedTask.tokenBudget,
        warningBudgetPressureEmitted: false,
        writeToolSucceeded: resumeCheckpoint.writeToolSucceeded
      });
    } catch (error) {
      resumedTask = this.dependencies.taskRepository.findById(taskId) ?? resumedTask;
      throw this.finalizeTaskFailure(resumedTask, toAppError(error));
    } finally {
      stopOutputSubscription?.();
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

    this.checkpointManager.delete(taskId);
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

  public failWaitingClarificationTask(taskId: string, error: AppError): TaskRecord {
    const task = this.dependencies.taskRepository.findById(taskId);
    if (task === null) {
      throw new AppError({
        code: "task_not_found",
        message: `Task ${taskId} was not found.`
      });
    }

    if (task.status !== "waiting_clarification") {
      return task;
    }

    this.checkpointManager.delete(taskId);
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
      summary: "Task finished with a clarification failure",
      taskId
    });

    return failedTask;
  }

  private async executeLoop(state: ExecutionLoopState): Promise<RuntimeRunResult> {
    return this.executionLoopRunner.executeLoop(state);
  }


  private async requestFinalSummaryWithoutTools(
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
  ): Promise<RuntimeRunResult> {
    const activeProvider = this.resolveActiveMainProvider(task);
    const baseSummaryPrompt =
      reason === "max_iterations_exhausted"
        ? `The loop reached its iteration budget (${state.maxIterations}). Do not call tools. Summarize the completed work, files changed or inspected, and any remaining work.`
        : reason === "empty_final_output"
          ? "The model attempted to finalize with an empty response. Do not call tools. Provide the final answer now based on everything you have learned so far."
          : reason === "unpolished_final_output"
            ? `Your previous response was internal reasoning or too long, not a polished user-facing answer. Do not call tools. Answer the user's request directly: "${task.input}". Be concise. Use a numbered list when the user asked for a specific count. Do not include chain-of-thought, self-dialogue, or draft candidate lists. Give final conclusions only with file paths and brief descriptions.`
            : "The task appears complete and further verification reads are no longer useful. Do not call tools. Provide the final answer now with completed work and any remaining notes.";
    const strictSuffix =
      " Respond with plain natural language only. Never output tool-call markup, DSML, XML tags, JSON tool schemas, or pseudo tool invocations.";
    const polishReason =
      reason === "unpolished_final_output" || reason === "empty_final_output";

    let finalMessage = "";
    let lastRejectionReason: string | null = null;
    let lastProviderResponse: ProviderResponse | undefined;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const summaryPrompt = attempt === 1 ? baseSummaryPrompt : `${baseSummaryPrompt}${strictSuffix}`;
      const finalMessages: ConversationMessage[] = [
        ...state.turnProviderMessages,
        {
          content: summaryPrompt,
          metadata: {
            privacyLevel: "internal",
            retentionKind: "session",
            sourceType: "system_prompt"
          },
          role: "system"
        }
      ];
      const startedAt = Date.now();
      let providerResponse: ProviderResponse;
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
          {
            agentProfileId: task.agentProfileId,
            availableTools: [],
            iteration: iteration + attempt,
            memoryContext: state.memoryContext,
            messages: finalMessages,
            ...(state.onAssistantTextDelta !== undefined
              ? { onTextDelta: state.onAssistantTextDelta }
              : {}),
            signal: state.managedAbortController.abortController.signal,
            task,
            tokenBudget: {
              ...state.tokenBudget,
              outputLimit: polishReason
                ? Math.min(state.tokenBudget.outputLimit, 2_000)
                : state.tokenBudget.outputLimit,
              reservedOutput: polishReason
                ? Math.min(state.tokenBudget.reservedOutput, 200)
                : state.tokenBudget.reservedOutput
            }
          }
        );
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        if (error instanceof Error && error.name === "AbortError") {
          throw new AppError({
            code: "interrupt",
            message: error.message
          });
        }
        throw toAppError(error);
      }
      lastProviderResponse = providerResponse;
      state.managedAbortController.touchActivity("no_tools_final_summary");

      this.dependencies.traceService.record({
        actor: `provider.${activeProvider.name}`,
        eventType: "provider_request_succeeded",
        payload: {
          attempt,
          iteration: iteration + attempt,
          kind: providerResponse.kind,
          latencyMs: Date.now() - startedAt,
          modelName:
            providerResponse.metadata?.modelName ??
            activeProvider.model ??
            activeProvider.describe?.().model ??
            null,
          providerName: providerResponse.metadata?.providerName ?? activeProvider.name,
          retryCount: providerResponse.metadata?.retryCount ?? 0,
          usage: providerUsageToJson(providerResponse.usage)
        },
        stage: "completion",
        summary: `No-tools final summary attempt ${attempt} completed with ${providerResponse.kind}`,
        taskId: task.taskId
      });

      if (providerResponse.kind === "tool_calls") {
        this.dependencies.traceService.record({
          actor: `provider.${activeProvider.name}`,
          eventType: "no_tools_tool_calls_ignored",
          payload: {
            attempt,
            iteration: iteration + attempt,
            message: providerResponse.message,
            reason,
            toolNames: providerResponse.toolCalls.map((call) => call.toolName)
          },
          stage: "completion",
          summary: "Ignored tool calls from no-tools final summary",
          taskId: task.taskId
        });
      }

      const responseForValidation =
        providerResponse.kind === "final"
          ? providerResponse
          : {
              kind: "final" as const,
              message: providerResponse.message
            };
      const resolvedText = (resolveProviderFinalText(responseForValidation) ?? "").trim();
      const acceptance = isAcceptableUserFinalText(responseForValidation, resolvedText);
      if (acceptance.acceptable) {
        finalMessage = resolvedText;
        break;
      }

      lastRejectionReason = acceptance.reason;
      this.dependencies.traceService.record({
        actor: "runtime.kernel",
        eventType: "invalid_final_output_rejected",
        payload: {
          attempt,
          reason: acceptance.reason,
          resolvedLength: resolvedText.length,
          summaryReason: reason
        },
        stage: "completion",
        summary: `No-tools final summary rejected (${acceptance.reason ?? "unknown"})`,
        taskId: task.taskId
      });
    }

    if (finalMessage.length === 0) {
      throw new AppError({
        code: lastRejectionReason === "empty" ? "max_rounds_exceeded" : "provider_error",
        message:
          lastRejectionReason === "tool_markup"
            ? "No-tools final summary returned tool-call markup instead of a user-facing answer."
            : lastRejectionReason === "empty"
              ? `Task exceeded ${state.maxIterations} iterations.`
              : "No-tools final summary did not produce an acceptable user-facing answer."
      });
    }

    messages.push({
      content: finalMessage,
      role: "assistant",
      ...(lastProviderResponse?.metadata?.raw !== undefined
        ? { metadata: lastProviderResponse.metadata.raw }
        : {})
    });
    const verificationDecision = this.completionController.evaluateFinalVerification(
      state,
      messages,
      task,
      iteration,
      finalMessage,
      { allowGuard: false }
    );
    const verifiedOutput =
      verificationDecision.kind === "complete" ? verificationDecision.finalOutput : finalMessage;
    if (verifiedOutput !== finalMessage) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage?.role === "assistant") {
        lastMessage.content = verifiedOutput;
      }
    }
    return this.completeTaskSuccess(state, messages, availableTools, task, verifiedOutput);
  }

  private completeTaskSuccess(
    state: ExecutionLoopState,
    messages: ConversationMessage[],
    availableTools: ProviderToolDescriptor[],
    task: TaskRecord,
    finalOutput: string
  ): RuntimeRunResult {
    this.checkpointManager.delete(task.taskId);
    const completedTask = this.dependencies.taskRepository.update(task.taskId, {
      finalOutput,
      finishedAt: new Date().toISOString(),
      status: "succeeded"
    });
    this.dependencies.memoryPlane.recordFinalOutcome(completedTask, finalOutput);
    this.appendSessionTranscript(completedTask, {
      content: finalOutput,
      eventType: "assistant_message",
      payload: {
        source: "final_output"
      },
      role: "assistant"
    });
    this.appendSessionTranscript(completedTask, {
      content: summarizeText(finalOutput, 240),
      eventType: "task_result",
      payload: {
        status: "succeeded"
      },
      role: "system"
    });

    this.dependencies.traceService.record({
      actor: "runtime.kernel",
      eventType: "final_outcome",
      payload: {
        errorCode: null,
        errorMessage: null,
        output: finalOutput,
        status: "succeeded"
      },
      stage: "completion",
      summary: "Task completed successfully",
      taskId: completedTask.taskId
    });
    this.dependencies.traceService.record({
      actor: "runtime.kernel",
      eventType: "task_success",
      payload: {
        cwd: completedTask.cwd,
        outputSummary: summarizeText(finalOutput, 240),
        status: "succeeded"
      },
      stage: "lifecycle",
      summary: "Task success lifecycle hook published",
      taskId: completedTask.taskId
    });
    this.dependencies.traceService.record({
      actor: "runtime.kernel",
      eventType: "session_end",
      payload: {
        status: "succeeded",
        summary: summarizeText(finalOutput, 240)
      },
      stage: "lifecycle",
      summary: "Session end lifecycle hook published",
      taskId: completedTask.taskId
    });
    emitTaskEvent(state.onTaskEvent, {
      errorCode: null,
      errorMessage: null,
      kind: "result",
      outputPreview: summarizeText(finalOutput, 200),
      status: "succeeded",
      taskId: completedTask.taskId
    });

    this.persistSessionTask(completedTask, completedTask.input, {
      finalOutput,
      status: completedTask.status
    });
    if (completedTask.sessionId !== null && completedTask.sessionId !== undefined) {
      const latestRun =
        this.dependencies.sessionTaskRepository.findByTaskId(completedTask.taskId) ??
        this.dependencies.sessionTaskRepository.findLatestBySessionId(completedTask.sessionId);
      const finalSessionSummaryDraft = this.dependencies.contextCompactor.buildSessionSummary({
        availableTools,
        compact: buildFinalSessionCompactInput(messages, completedTask),
        pinnedUserMessages: this.resolvePinnedUserMessages(completedTask.sessionId),
        previousSessionSummary: this.dependencies.sessionSummaryService.findLatestBySession(completedTask.sessionId),
        sessionTodos: this.resolveSessionTodos(completedTask.sessionId),
        task: completedTask,
        trigger: "final"
      });
      this.dependencies.sessionSummaryService.create({
        ...finalSessionSummaryDraft,
        runId: latestRun?.runId ?? null,
        sessionId: completedTask.sessionId,
        trigger: "final"
      });
    }

    this.projectSessionMessages(completedTask, finalOutput);

    this.dependencies.memoryBackgroundReviewService?.schedule({
      iteration: state.task.currentIteration,
      messages,
      provider: this.dependencies.provider,
      signal: state.managedAbortController.abortController.signal,
      task: completedTask,
      tokenBudget: state.tokenBudget
    });

    return {
      output: finalOutput,
      task: completedTask
    };
  }

  private projectSessionMessages(task: TaskRecord, assistantText: string): void {
    if (
      task.sessionId === null ||
      task.sessionId === undefined ||
      this.dependencies.sessionMessageProjector === undefined
    ) {
      return;
    }
    this.dependencies.sessionMessageProjector.projectTaskExchange({
      assistantText,
      entrySource: resolveTaskEntrySource(task),
      sessionId: task.sessionId,
      taskId: task.taskId,
      userText: task.input
    });
  }

  private buildCompactInput(input: {
    iteration: number;
    messages: ConversationMessage[];
    pendingToolCalls: ProviderToolCall[];
    state: ExecutionLoopState;
    task: TaskRecord;
  }): Parameters<CompactTriggerPolicy["shouldCompact"]>[0] {
    const tokenThreshold =
      this.dependencies.compact.tokenThreshold ??
      computeCompactThreshold(input.state.tokenBudget.inputLimit, this.dependencies.compact.thresholdRatio);
    const previousSummary =
      input.task.sessionId === null || input.task.sessionId === undefined
        ? undefined
        : this.dependencies.sessionSummaryService.findLatestBySession(input.task.sessionId)?.summary;
    return {
      contextWindowTokens: input.state.tokenBudget.inputLimit,
      iteration: input.state.iterationsSinceLastCompact,
      iterationThreshold: this.dependencies.compact.iterationThreshold,
      maxMessagesBeforeCompact: this.dependencies.compact.messageThreshold,
      messages: input.messages,
      originalGoal: input.task.input,
      pendingToolCalls: input.pendingToolCalls.map((call) => ({
        toolCallId: call.toolCallId,
        toolName: call.toolName
      })),
      ...(previousSummary !== undefined ? { previousSummary } : {}),
      ...(input.state.recentFileReadCache === null
        ? {}
        : {
            recentlyReadFilesSummary: formatRecentlyReadFilesSummary(
              input.state.recentFileReadCache.list()
            )
          }),
      protectFirstN: this.dependencies.compact.protectFirstN,
      protectLastN: this.dependencies.compact.protectLastN,
      sessionScopeKey: input.task.sessionId ?? input.task.taskId,
      targetTokenBudget: Math.floor(input.state.tokenBudget.inputLimit * this.dependencies.compact.targetRatio),
      taskId: input.task.taskId,
      tokenEstimate: computePromptTokens(input.state.tokenCounter, input.messages),
      tokenThreshold,
      toolCallCount: input.state.cumulativeToolCallCount,
      toolCallThreshold: this.dependencies.compact.toolCallThreshold,
      minTokenPressureRatio: this.dependencies.compact.minTokenPressureRatio,
      compactCooldownRemaining: input.state.compactCooldownRemaining
    };
  }

  private hasRecoveryBeenUsed(taskId: string): boolean {
    return this.dependencies.traceService
      .listByTaskId(taskId)
      .some((event) => event.eventType === "task_recovery_started");
  }

  private createContextLoopFields(): Pick<
    ExecutionLoopState,
    "compactedCount" | "compactCooldownRemaining" | "microPrunedCount" | "recentFileReadCache" | "tokenCounter" | "toolArtifactsRoot"
  > {
    return {
      compactedCount: 0,
      compactCooldownRemaining: 0,
      microPrunedCount: 0,
      recentFileReadCache:
        this.dependencies.contextRetention === undefined
          ? null
          : new RecentFileReadCache(this.dependencies.contextRetention),
      tokenCounter: createHybridTokenCounterState(),
      toolArtifactsRoot: join(this.dependencies.workspaceRoot, ".auto-talon", "artifacts")
    };
  }

  private syncRecentFileCacheMode(
    state: ExecutionLoopState,
    pendingToolCalls: ProviderToolCall[],
    availableTools: ProviderToolDescriptor[]
  ): void {
    if (state.recentFileReadCache === null) {
      return;
    }
    const writePending = pendingToolCalls.some((call) => {
      const descriptor = availableTools.find((tool) => tool.name === call.toolName);
      return descriptor?.capability === "filesystem.write";
    });
    state.recentFileReadCache.setMode(writePending ? "write_required" : "normal");
  }

  private async compactMessages(
    input: Parameters<CompactTriggerPolicy["shouldCompact"]>[0],
    manualRequest: ManualCompactRequest | null = null
  ): Promise<SessionCompactResult> {
    const decision =
      manualRequest !== null
        ? { reason: "token_budget" as const, triggered: true }
        : this.dependencies.compactPolicy.shouldCompact(input);
    this.dependencies.traceService.record({
      actor: "runtime.context",
      eventType: "compact_evaluated",
      payload: {
        compactCooldownRemaining: input.compactCooldownRemaining ?? null,
        messageCount: input.messages.length,
        maxMessagesBeforeCompact: input.maxMessagesBeforeCompact,
        reason: decision.reason,
        tokenEstimate: input.tokenEstimate ?? null,
        tokenThreshold: input.tokenThreshold ?? null,
        toolCallCount: input.toolCallCount ?? null,
        toolCallThreshold: input.toolCallThreshold ?? null,
        triggered: decision.triggered
      },
      stage: "memory",
      summary: decision.triggered
        ? `Compaction triggered (${decision.reason ?? "unknown"})`
        : `Compaction skipped (${decision.reason ?? "below_threshold"})`,
      taskId: input.taskId
    });
    if (!decision.triggered) {
      return Promise.resolve({
        reason: null,
        replacementMessages: input.messages.map((message) => mapCompactConversationMessage(message)),
        summaryMemory: null,
        triggered: false
      });
    }

    const messagesToSummarize = input.messages as ConversationMessage[];
    const contextWindowTokens = input.contextWindowTokens ?? input.tokenThreshold ?? 0;
    const summarizer = this.selectCompactSummarizer(
      input.taskId,
      input.sessionScopeKey,
      contextWindowTokens
    );
    let summarized;
    try {
      summarized = await summarizer.summarize({
        maxMessagesBeforeCompact: input.maxMessagesBeforeCompact,
        messages: messagesToSummarize,
        ...(input.originalGoal !== undefined ? { originalGoal: input.originalGoal } : {}),
        ...(input.previousSummary !== undefined ? { previousSummary: input.previousSummary } : {}),
        ...(input.focusTopic !== undefined ? { focusTopic: input.focusTopic } : {}),
        ...(input.recentlyReadFilesSummary !== undefined
          ? { recentlyReadFilesSummary: input.recentlyReadFilesSummary }
          : {}),
        sessionScopeKey: input.sessionScopeKey,
        taskId: input.taskId
      });
    } catch (error) {
      this.dependencies.traceService.record({
        actor: "runtime.context",
        eventType: "compact_summarizer_failed",
        payload: {
          error: error instanceof Error ? error.message : String(error),
          summarizer: this.dependencies.compact.summarizer
        },
        stage: "memory",
        summary: "Session compaction summarizer failed",
        taskId: input.taskId
      });
      throw error;
    }
    const protectedHead = selectHeadMessages(
      messagesToSummarize,
      input.protectFirstN ?? this.dependencies.compact.protectFirstN
    );
    const preservedTail = selectTailMessages(messagesToSummarize, {
      protectLastN: input.protectLastN ?? this.dependencies.compact.protectLastN,
      tailMinMessages: this.dependencies.compact.tailMinMessages,
      tailTokenBudget:
        this.dependencies.compact.tailTokenBudget ??
        input.targetTokenBudget ??
        Math.floor(contextWindowTokens * this.dependencies.compact.targetRatio)
    });
    if (preservedTail.budgetExceeded) {
      this.dependencies.traceService.record({
        actor: "runtime.context",
        eventType: "tail_budget_exceeded",
        payload: {
          protectLastN: input.protectLastN ?? this.dependencies.compact.protectLastN,
          tailMessageCount: preservedTail.messages.length,
          tailTokenBudget:
            this.dependencies.compact.tailTokenBudget ??
            input.targetTokenBudget ??
            Math.floor(contextWindowTokens * this.dependencies.compact.targetRatio),
          usedTokens: preservedTail.usedTokens
        },
        stage: "memory",
        summary: "Protected tail messages exceed tail token budget",
        taskId: input.taskId
      });
    }
    const preservedMessages = mergeProtectedMessages(protectedHead, preservedTail.messages);
    const protectedHeadCount = Math.min(protectedHead.length, preservedMessages.length);
    const preserved = preservedMessages.map((message) => mapCompactConversationMessage(message));
    const discardedMessages = listDiscardedMessages(messagesToSummarize, preservedMessages);

    return {
      reason:
        decision.reason === "token_budget" ||
        decision.reason === "tool_call_count" ||
        decision.reason === "iteration_count"
          ? decision.reason
          : "message_count",
      replacementMessages: [
        ...preserved.slice(0, protectedHeadCount),
        {
          content: buildSessionHandoffMessageContent({
            compactedMessages: discardedMessages,
            summary: summarized.summary
          }),
          metadata: {
            privacyLevel: "internal",
            retentionKind: "session",
            sourceType: "compact_handoff"
          },
          role: "system"
        },
        ...preserved.slice(protectedHeadCount)
      ],
      summaryMemory: null,
      triggered: true
    };
  }

  private createAuxiliaryFailoverProvider(
    provider: Provider,
    input: { sessionId: string | null; slot: string; taskId: string }
  ): Provider {
    void input.sessionId;
    return {
      capabilities: provider.capabilities,
      describe: provider.describe?.bind(provider),
      fetchContextWindow: provider.fetchContextWindow?.bind(provider),
      generate: (request) =>
        generateWithProviderFailover(
          {
            auditService: this.dependencies.auditService,
            auxiliarySlot: input.slot,
            cwd: this.dependencies.workspaceRoot,
            enableFailover: true,
            primaryProvider: provider,
            taskId: input.taskId,
            traceService: this.dependencies.traceService
          },
          request
        ),
      getStats: provider.getStats?.bind(provider),
      model: provider.model,
      name: provider.name,
      streamGenerate: provider.streamGenerate?.bind(provider),
      testConnection: provider.testConnection?.bind(provider)
    };
  }
  private selectCompactSummarizer(
    taskId: string,
    sessionId: string | null,
    mainContextWindowTokens: number
  ): CompactSummarizer {
    if (this.dependencies.compact.summarizer !== "provider_subagent") {
      return new DeterministicCompactSummarizer();
    }
    if (sessionId !== null && this.hasStructuredSessionMemory(sessionId)) {
      return new DeterministicCompactSummarizer();
    }
    const helperProvider =
      this.dependencies.auxiliaryProviderResolver?.resolve("compression", {
        sessionId,
        taskId
      }) ??
      this.dependencies.providerRouter?.selectProvider({
        kind: "summarize",
        taskId,
        sessionId
      }).provider ??
      this.dependencies.provider;
    const helperContextWindow =
      helperProvider.describe?.().contextWindowTokens ?? Math.min(mainContextWindowTokens, 32_000);
    const failoverHelperProvider = this.createAuxiliaryFailoverProvider(helperProvider, {
      sessionId,
      slot: "compression",
      taskId
    });
    return new ProviderSubagentSummarizer(
      (context) => {
        if (context.kind !== "summarize") {
          return null;
        }
        return failoverHelperProvider;
      },
      { maxInputTokens: helperContextWindow }
    );
  }

  private hasStructuredSessionMemory(sessionId: string): boolean {
    const summary = this.dependencies.sessionSummaryService.findLatestBySession(sessionId);
    if (summary === null) {
      return false;
    }
    const pinned = summary.metadata?.userMessagePin;
    const featureBacklog = summary.metadata?.featureBacklog;
    return (
      Array.isArray(pinned) &&
      pinned.length > 0 &&
      Array.isArray(featureBacklog) &&
      featureBacklog.length > 0 &&
      summary.decisions.length > 0
    );
  }

  private resolvePinnedUserMessages(sessionId: string): string[] {
    if (this.dependencies.sessionMessageRepository === undefined) {
      return [];
    }
    return pinUserMessagesFromRecords(
      this.dependencies.sessionMessageRepository.listBySessionId(sessionId)
    );
  }

  private resolveSessionTodos(sessionId: string): TodoItem[] {
    return this.dependencies.todoSessionStore?.get(sessionId) ?? [];
  }

  private supersedeStaleSessionTasks(sessionId: string, activeTaskId: string): void {
    for (const sessionTask of this.dependencies.sessionTaskRepository.listBySessionId(sessionId)) {
      if (sessionTask.taskId === activeTaskId) {
        continue;
      }
      const staleTask = this.dependencies.taskRepository.findById(sessionTask.taskId);
      if (staleTask === null || staleTask.status !== "running") {
        continue;
      }
      this.dependencies.taskRepository.update(staleTask.taskId, {
        errorCode: "cancelled",
        errorMessage: "Superseded by a newer session task.",
        finishedAt: new Date().toISOString(),
        status: "cancelled"
      });
      this.dependencies.traceService.record({
        actor: "runtime.kernel",
        eventType: "task_superseded",
        payload: {
          activeTaskId,
          sessionId,
          supersededTaskId: staleTask.taskId
        },
        stage: "lifecycle",
        summary: "Stale running task cancelled for session continuation",
        taskId: activeTaskId
      });
    }
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

    this.checkpointManager.delete(task.taskId);
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

    this.persistSessionTask(task, task.input, {
      errorCode: error.code,
      errorMessage: error.message,
      status: isCancelled ? "cancelled" : "failed"
    });

    const updatedTask = this.dependencies.taskRepository.findById(task.taskId) ?? task;
    this.projectSessionMessages(updatedTask, error.message);

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

  private persistSessionTask(
    task: TaskRecord,
    input: string,
    summary: {
      status: TaskRecord["status"];
      finalOutput?: string | null;
      errorCode?: string | null;
      errorMessage?: string | null;
    }
  ): void {
    if (task.sessionId === null || task.sessionId === undefined) {
      return;
    }
    if (this.dependencies.sessionTaskRepository.findByTaskId(task.taskId) !== null) {
      return;
    }
    this.dependencies.sessionTaskRepository.create({
      createdAt: task.startedAt ?? task.createdAt,
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
      sessionId: task.sessionId
    });
  }

  private appendSessionTranscript(
    task: TaskRecord,
    event: {
      content: string | null;
      eventType: Parameters<SessionTranscriptRepository["append"]>[0]["eventType"];
      payload?: Parameters<SessionTranscriptRepository["append"]>[0]["payload"];
      role: Parameters<SessionTranscriptRepository["append"]>[0]["role"];
    }
  ): void {
    if (task.sessionId === null || task.sessionId === undefined) {
      return;
    }
    this.dependencies.sessionTranscriptRepository.append({
      content: event.content,
      eventType: event.eventType,
      payload: event.payload ?? {},
      role: event.role ?? null,
      sessionId: task.sessionId,
      taskId: task.taskId
    });
  }

  private emitOutput(draft: Parameters<RuntimeOutputService["record"]>[0]): RuntimeOutputEvent {
    return this.dependencies.outputService.record(draft);
  }

  private buildExplicitSkillMetadata(input: string): Record<string, unknown> {
    const activations = this.dependencies.skillContextService?.resolveExplicitSkillActivations(input) ?? [];
    if (activations.length === 0) {
      return {};
    }
    const allowedTools = intersectNonEmpty(activations.map((activation) => activation.allowedTools));
    const disallowedTools = uniqueStringsFromArrays(
      activations.map((activation) => activation.disallowedTools)
    );
    const forkedSkills = activations
      .filter((activation) => activation.context === "fork" && activation.agent !== null)
      .map((activation) => ({
        agent: activation.agent,
        skillId: activation.skillId
      }));
    return {
      activeSkills: activations.map((activation) => ({
        arguments: activation.arguments,
        skillId: activation.skillId
      })),
      ...(allowedTools.length > 0 || disallowedTools.length > 0
        ? {
            activeSkillToolConstraints: {
              ...(allowedTools.length > 0 ? { allowedTools } : {}),
              ...(disallowedTools.length > 0 ? { disallowedTools } : {})
            }
          }
        : {}),
      ...(forkedSkills.length > 0 ? { activeForkedSkills: forkedSkills } : {})
    };
  }
}

function intersectNonEmpty(groups: string[][]): string[] {
  const nonEmpty = groups.filter((group) => group.length > 0);
  if (nonEmpty.length === 0) {
    return [];
  }
  const [first, ...rest] = nonEmpty;
  if (first === undefined) {
    return [];
  }
  return uniqueStrings(first).filter((tool) => rest.every((group) => group.includes(tool)));
}

function uniqueStringsFromArrays(groups: string[][]): string[] {
  return uniqueStrings(groups.flat());
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function formatWorkflowTestCommandHints(
  commands: WorkflowRuntimeConfig["testCommands"]
): string[] {
  return commands.map((command) => (typeof command === "string" ? command : command.command));
}

function resolveTaskEntrySource(task: TaskRecord): SessionEntrySource {
  const gateway = task.metadata?.gateway;
  if (gateway !== null && gateway !== undefined && typeof gateway === "object") {
    const adapterId = (gateway as { adapterId?: unknown }).adapterId;
    if (typeof adapterId === "string" && adapterId.length > 0) {
      return "gateway";
    }
  }
  const source = task.metadata?.source;
  if (source === "tui" || source === "cli" || source === "schedule" || source === "gateway") {
    return source;
  }
  return "cli";
}

function readInteractionModeFromMetadata(metadata: Record<string, unknown> | undefined): RuntimeRunOptions["interactionMode"] {
  if (metadata?.interactionMode === "plan") {
    return "plan";
  }
  if (metadata?.interactionMode === "acceptEdits") {
    return "acceptEdits";
  }
  return "agent";
}

function mapCompactConversationMessage(message: {
  role: string;
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string }>;
  metadata?: ConversationMessage["metadata"];
}): ConversationMessage {
  const mapped: ConversationMessage = {
    content: message.content,
    role: toConversationRole(message.role)
  };
  if (message.toolCallId !== undefined) {
    mapped.toolCallId = message.toolCallId;
  }
  if (message.toolName !== undefined) {
    mapped.toolName = message.toolName;
  }
  if (message.toolCalls !== undefined) {
    mapped.toolCalls = message.toolCalls as ProviderToolCall[];
  }
  if (message.metadata !== undefined) {
    mapped.metadata = message.metadata;
  }
  return mapped;
}

function selectHeadMessages(messages: ConversationMessage[], protectFirstN: number): ConversationMessage[] {
  if (protectFirstN <= 0) {
    return [];
  }
  const selected: ConversationMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }
    selected.push(message);
    if (selected.length >= protectFirstN) {
      break;
    }
  }
  return selected;
}

function mergeProtectedMessages(
  head: ConversationMessage[],
  tail: ConversationMessage[]
): ConversationMessage[] {
  const merged: ConversationMessage[] = [];
  const seen = new Set<string>();
  for (const message of [...head, ...tail]) {
    const key = compactMessageIdentity(message);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(message);
  }
  return merged;
}

function compactMessageIdentity(message: ConversationMessage): string {
  const toolCalls = message.toolCalls?.map((call) => call.toolCallId).join(",") ?? "";
  return [
    message.role,
    message.toolCallId ?? "",
    message.toolName ?? "",
    toolCalls,
    message.content
  ].join("\u0000");
}

