import { randomUUID } from "node:crypto";

import type { ApprovalRuleStore } from "../approvals/approval-rule-store.js";
import type { ApprovalService } from "../approvals/approval-service.js";
import type { ClarifyService } from "../approvals/clarify-service.js";
import type { AuditService } from "../audit/audit-service.js";
import type {
  ExperiencePlane,
  ExperiencePromoteResult,
  ExperienceReviewRequest
} from "../experience/experience-plane.js";
import {
  type ProviderCatalogEntry,
  type ResolvedProviderConfig
} from "../providers/index.js";
import type { AuxiliaryProviderResolver } from "../providers/auxiliary-resolver.js";
import type { ProviderRouter } from "../providers/routing/provider-router.js";
import {
  type RuntimeConfig,
  type ShellBackend,
  type WorkflowCustomShell,
  type WorkflowTestCommand
} from "./runtime-config.js";
import { resolveRuntimeConfig, writeMemoryEnabled } from "./runtime-config.js";
import type { BudgetService } from "./budget/budget-service.js";
import type {
  ApprovalRecord,
  ApprovalAllowScope,
  ArtifactRecord,
  AuditLogRecord,
  ClarifyPromptRecord,
  CommitmentDraft,
  CommitmentListQuery,
  CommitmentRecord,
  ContextFragment,
  ExecutionCheckpointRecord,
  ExperienceQuery,
  ExperienceRecord,
  InboxDeliveryEvent,
  InboxItem,
  GatewaySessionRepository,
  JsonValue,
  InboxListQuery,
  JsonObject,
  MemoryRecord,
  MemoryScope,
  MemorySnapshotRecord,
  Provider,
  ProviderStatsSnapshot,
  ProviderHealthCheck,
  RuntimeOutputEvent,
  RuntimeRunOptions,
  NextActionDraft,
  NextActionRecord,
  NextActionListQuery,
  ScheduleListQuery,
  ScheduleRecord,
  ScheduleRunListQuery,
  ScheduleRunRecord,
  SessionMessageRepository,
  SessionSearchHit,
  SessionLineageRepository,
  TaskRecord,
  SessionLineageRecord,
  SessionTranscriptRepository,
  SessionRecord,
  SessionTaskRecord,
  SessionSummaryRecord,
  SessionCommitmentState,
  SessionIndexEntry,
  SessionMessageSearchHit,
  SessionListQuery,
  SessionUiState,
  TokenBudget,
  TraceEvent,
  ToolCallRecord,
  TaskUpdatePatch
} from "../types/index.js";
import type { TraceService } from "../tracing/trace-service.js";
import type { RuntimeOutputService } from "./runtime-output-service.js";
import type { MemoryPlane } from "../memory/memory-plane.js";
import { extractMemoryKeywords } from "../memory/memory-keywords.js";
import type { SkillAttachmentKind } from "../types/skill.js";
import type { SkillDraftManager, SkillRegistry } from "../skills/index.js";
import type { TodoItem, TodoSessionStore } from "../tools/todo-session-store.js";
import type { ToolOverrideStore } from "../tools/tool-overrides.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { ManualCompactCoordinator } from "./context/manual-compact-coordinator.js";
import type { ExecutionKernel } from "./execution-kernel.js";
import type { ResumePacketBuilder, SessionService } from "./sessions/index.js";
import type {
  SessionUiStateService,
  SaveSessionUiStateInput
} from "./sessions/session-ui-state-service.js";
import type { SessionIndexService } from "./sessions/session-index-service.js";
import type { SessionMessageSearchService } from "./sessions/session-message-search-service.js";
import type { SessionBranchService } from "./sessions/session-branch-service.js";
import type { SessionHandoffService, SessionHandoffRequest } from "./sessions/session-handoff-service.js";
import { resolveSessionRef, type ResolveSessionRefResult } from "./sessions/session-resolver.js";
import type { TranscriptMigrationResult } from "./sessions/transcript-migrator.js";
import { migrateLegacyTranscriptFiles } from "./sessions/transcript-migrator.js";
import type { CreateScheduleInput, ScheduleRunLifecycle, SchedulerService, UpdateScheduleInput } from "./scheduler/index.js";
import type { SessionExecutionLock } from "./sessions/session-execution-lock.js";
import { isTerminalTaskStatus } from "./sessions/session-execution-lock.js";
import type { InboxService } from "./inbox/index.js";
import type {
  AssistantSessionProjectionService,
  CommitmentService,
  NextActionService,
  SessionCommitmentProjector
} from "./commitments/index.js";
import { FileRollbackService, ProviderStatsService, RuntimeDoctorService } from "./operations/index.js";
import {
  listConfiguredProviders,
  type ConfiguredProviderEntry,
  type ProviderSwitchPersistScope,
  type SwitchProviderResult
} from "./operations/provider-switch-service.js";
import type { ModelSelectionView } from "./operations/model-selection-service.js";
import type { ContextCompactor, SessionSummaryService } from "./context/index.js";
import {
  ApprovalResolutionFacade,
  ClarifyResolutionFacade,
  ProviderSwitchFacade,
  ScheduleFacade,
  SessionFacade
} from "./facades/index.js";

import { AppError } from "./app-error.js";

export interface RunTaskResult {
  error?: AppError;
  output: string | null;
  task: TaskRecord;
}

export interface ApprovalActionResult {
  approval: ApprovalRecord;
  error?: AppError;
  output: string | null;
  task: TaskRecord;
}

export interface ClarifyActionResult {
  error?: AppError;
  output: string | null;
  prompt: ClarifyPromptRecord;
  task: TaskRecord;
}

export interface AgentDoctorReport {
  apiKeyConfigured: boolean;
  configPath: string;
  configSource: "defaults" | "env" | "file" | "user";
  databasePath: string;
  endpointReachable: boolean | null;
  experienceStats: {
    accepted: number;
    candidate: number;
    promoted: number;
    rejected: number;
    stale: number;
    total: number;
  };
  issues: string[];
  allowedFetchHosts: string[];
  maxRetries: number;
  modelAvailable: boolean | null;
  modelConfigured: boolean;
  modelName: string | null;
  nodeVersion: string;
  pnpmVersion: string | null;
  corepackAvailable: boolean;
  providerHealthMessage: string;
  providerName: string;
  runtimeConfigPath: string;
  runtimeConfigSource: "defaults" | "env" | "file";
  runtimeVersion: string;
  configFiles: Array<{ exists: boolean; file: string; parseable: boolean }>;
  workspaceSecretFindings: Array<{ file: string; fields: string[] }>;
  databaseReachable: boolean;
  distFresh: boolean | null;
  schemaVersion: number | null;
  shell: string | undefined;
  shellBackend: ShellBackend;
  shellBackendAvailable: boolean;
  shellExecutable: string;
  shellMaxTimeoutMs: number;
  skillStats: {
    enabled: number;
    issues: number;
    total: number;
  };
  tokenBudget: {
    inputLimit: number;
    outputLimit: number;
    reservedOutput: number;
  };
  timeoutMs: number;
  streamIdleTimeoutMs: number;
  workspaceRoot: string;
  providerRouter?: ProviderRouter;
  budgetService?: BudgetService;
}

export interface ContextTraceDebugReport {
  contextAssembly: Extract<TraceEvent, { eventType: "context_assembled" }>["payload"]["debugView"] | null;
  memoryRecall:
    | Extract<TraceEvent, { eventType: "memory_recalled" }>["payload"]
    | null;
  reviewerTrace:
    | Extract<TraceEvent, { eventType: "reviewer_trace" }>["payload"]
    | null;
  latestSessionSummary:
    | Extract<TraceEvent, { eventType: "session_summary_written" }>["payload"]
    | null;
  task: TaskRecord | null;
}

export interface RollbackFileArtifactResult {
  artifact: ArtifactRecord;
  deleted: boolean;
  path: string;
  restored: boolean;
}

export interface RuntimeReadModel {
  findExperience(experienceId: string): ExperienceRecord | null;
  findArtifact(artifactId: string): ArtifactRecord | null;
  findLatestArtifactByType(artifactType: string): ArtifactRecord | null;
  findMemory(memoryId: string): MemoryRecord | null;
  findTask(taskId: string): TaskRecord | null;
  listApprovals(taskId: string): ApprovalRecord[];
  listClarifyPrompts(taskId: string): ClarifyPromptRecord[];
  listArtifacts(taskId: string): ArtifactRecord[];
  listAuditLogs(taskId: string): AuditLogRecord[];
  listExperiences(): ExperienceRecord[];
  listMemorySnapshots(scope: MemoryScope, scopeKey: string): MemorySnapshotRecord[];
  listPendingApprovals(): ApprovalRecord[];
  listPendingClarifyPrompts(): ClarifyPromptRecord[];
  listMemories(): MemoryRecord[];
  listTasks(): TaskRecord[];
  listSessionLineage(sessionId: string): SessionLineageRecord[];
  listSessionTasks(sessionId: string): SessionTaskRecord[];
  listSessionSummaries(sessionId: string): SessionSummaryRecord[];
  searchSessionSummaries(input: {
    limit: number;
    query: string;
    sessionId?: string;
    excludeSessionId?: string | null;
  }): SessionSearchHit[];
  findSessionSummary(sessionSummaryId: string): SessionSummaryRecord | null;
  listSchedules(query?: ScheduleListQuery): ScheduleRecord[];
  findSchedule(scheduleId: string): ScheduleRecord | null;
  listScheduleRuns(scheduleId: string, query?: ScheduleRunListQuery): ScheduleRunRecord[];
  listScheduleRunsByTask(taskId: string): ScheduleRunRecord[];
  listScheduleRunsBySession(sessionId: string): ScheduleRunRecord[];
  listInboxItems(query?: InboxListQuery): InboxItem[];
  findInboxItem(inboxId: string): InboxItem | null;
  listSessions(): SessionRecord[];
  findSession(sessionId: string): SessionRecord | null;
  listToolCalls(taskId: string): ToolCallRecord[];
  listOutputEvents(taskId: string): RuntimeOutputEvent[];
  listSessionOutputEvents(sessionId: string): RuntimeOutputEvent[];
  listTrace(taskId: string): TraceEvent[];
  findExecutionCheckpoint(taskId: string): ExecutionCheckpointRecord | null;
  saveExecutionCheckpoint(record: ExecutionCheckpointRecord): ExecutionCheckpointRecord;
  updateTask(taskId: string, patch: TaskUpdatePatch): TaskRecord;
  updateToolCall(toolCallId: string, patch: Partial<ToolCallRecord>): ToolCallRecord;
}

export interface ProviderSmokeReport {
  errorCategory: string | null;
  latencyMs: number;
  message: string;
  modelName: string | null;
  ok: boolean;
  providerName: string;
  streamIdleTimeoutMs: number;
  timeoutMs: number;
}

export interface AgentApplicationServiceDependencies extends RuntimeReadModel {
  approvalRuleStore: ApprovalRuleStore;
  approvalService: ApprovalService;
  auditService: AuditService;
  clarifyService: ClarifyService;
  customShell: WorkflowCustomShell | null;
  databasePath: string;
  executionKernel: ExecutionKernel;
  contextCompactor: ContextCompactor;
  compact: RuntimeConfig["compact"];
  schedulerService: SchedulerService;
  scheduleRunLifecycle: ScheduleRunLifecycle;
  resumePacketBuilder: ResumePacketBuilder;
  sessionSummaryService: SessionSummaryService;
  sessionService: SessionService;
  experiencePlane: ExperiencePlane;
  maxShellTimeoutMs: number;
  memoryPlane: MemoryPlane;
  provider: Provider;
  providerCatalog: ProviderCatalogEntry[];
  providerConfig: ResolvedProviderConfig;
  allowedFetchHosts: string[];
  runtimeVersion: string;
  runtimeConfigPath: string;
  runtimeConfigSource: "defaults" | "env" | "file";
  skillDraftManager: SkillDraftManager;
  skillRegistry: SkillRegistry;
  todoSessionStore: TodoSessionStore;
  toolOverrideStore: ToolOverrideStore;
  toolRegistry: ToolRegistry;
  shellBackend: ShellBackend;
  inboxService: InboxService;
  commitmentService: CommitmentService;
  nextActionService: NextActionService;
  sessionCommitmentProjector: SessionCommitmentProjector;
  tokenBudget: TokenBudget;
  tokenBudgetInputLimitExplicit: boolean;
  traceService: TraceService;
  testCommands: WorkflowTestCommand[];
  outputService: RuntimeOutputService;
  assistantSessionProjectionService: AssistantSessionProjectionService;
  sessionUiStateService: SessionUiStateService;
  sessionIndexService: SessionIndexService;
  sessionMessageSearchService: SessionMessageSearchService;
  sessionMessageRepository: SessionMessageRepository;
  sessionTranscriptRepository: SessionTranscriptRepository;
  sessionLineageRepository: SessionLineageRepository;
  sessionBranchService: SessionBranchService;
  sessionHandoffService: SessionHandoffService;
  sessionExecutionLock: SessionExecutionLock;
  gatewaySessionRepository: GatewaySessionRepository;
  manualCompactCoordinator: ManualCompactCoordinator;
  providerRouter?: ProviderRouter;
  auxiliaryProviderResolver?: AuxiliaryProviderResolver;
  budgetService?: BudgetService;
  workspaceRoot: string;
  collectLegacyWorkspaceIssues: () => string[];
  finalizeLegacyThreadSchema: () => void;
}

export interface TaskTimelineEntry {
  actor: string;
  detail: string;
  eventType: TraceEvent["eventType"];
  iteration: number | null;
  sequence: number;
  stage: TraceEvent["stage"];
  timestamp: string;
}

export interface TaskTimelineReport {
  entries: TaskTimelineEntry[];
  task: TaskRecord | null;
}

export class AgentApplicationService {
  private readonly sessionFacade: SessionFacade;
  private readonly scheduleFacade: ScheduleFacade;
  private readonly approvalResolutionFacade: ApprovalResolutionFacade;
  private readonly clarifyResolutionFacade: ClarifyResolutionFacade;
  private readonly providerSwitchFacade: ProviderSwitchFacade;

  public constructor(private readonly dependencies: AgentApplicationServiceDependencies) {
    this.sessionFacade = new SessionFacade(
      dependencies,
      (sessionId, taskId, output) => this.projectAssistantOutput(sessionId, taskId, output)
    );
    this.scheduleFacade = new ScheduleFacade(dependencies);
    this.approvalResolutionFacade = new ApprovalResolutionFacade(
      {
        approvalRuleStore: dependencies.approvalRuleStore,
        approvalService: dependencies.approvalService,
        auditService: dependencies.auditService,
        executionKernel: dependencies.executionKernel,
        findTask: (taskId) => dependencies.findTask(taskId),
        scheduleRunLifecycle: dependencies.scheduleRunLifecycle,
        sessionUiStateService: dependencies.sessionUiStateService,
        traceService: dependencies.traceService,
        updateTask: (taskId, patch) => dependencies.updateTask(taskId, patch)
      },
      {
        projectAssistantOutput: (sessionId, taskId, output) =>
          this.projectAssistantOutput(sessionId, taskId, output),
        releaseSessionLockIfTerminal: (task) => this.releaseSessionLockIfTerminal(task)
      }
    );
    this.clarifyResolutionFacade = new ClarifyResolutionFacade(
      {
        clarifyService: dependencies.clarifyService,
        executionKernel: dependencies.executionKernel,
        findExecutionCheckpoint: (taskId) => dependencies.findExecutionCheckpoint(taskId),
        findTask: (taskId) => dependencies.findTask(taskId),
        saveExecutionCheckpoint: (record) => dependencies.saveExecutionCheckpoint(record),
        scheduleRunLifecycle: dependencies.scheduleRunLifecycle,
        traceService: dependencies.traceService
      },
      {
        projectAssistantOutput: (sessionId, taskId, output) =>
          this.projectAssistantOutput(sessionId, taskId, output),
        releaseSessionLockIfTerminal: (task) => this.releaseSessionLockIfTerminal(task)
      }
    );
    this.providerSwitchFacade = new ProviderSwitchFacade({
      auditService: dependencies.auditService,
      findSession: (sessionId) => dependencies.findSession(sessionId),
      listPendingApprovals: () => dependencies.listPendingApprovals(),
      listPendingClarifyPrompts: () => dependencies.listPendingClarifyPrompts(),
      listTasks: () => dependencies.listTasks(),
      runtime: dependencies,
      sessionService: dependencies.sessionService,
      tokenBudgetInputLimitExplicit: dependencies.tokenBudgetInputLimitExplicit,
      traceService: dependencies.traceService,
      workspaceRoot: dependencies.workspaceRoot
    });
  }

  public async runTask(options: RuntimeRunOptions): Promise<RunTaskResult> {
    return this.sessionFacade.runTask(options);
  }

  public listTasks(): TaskRecord[] {
    return this.sessionFacade.listTasks();
  }

  public createSession(input: {
    agentProfileId: SessionRecord["agentProfileId"];
    cwd: string;
    metadata?: JsonObject;
    ownerUserId: string;
    providerName?: string;
    title?: string;
  }): SessionRecord {
    return this.sessionFacade.createSession(input);
  }

  public loadSessionUiState(sessionId: string): SessionUiState | null {
    return this.dependencies.sessionUiStateService.load(sessionId);
  }

  public getSessionTodos(sessionId: string): TodoItem[] {
    return this.dependencies.todoSessionStore.get(sessionId);
  }

  public requestManualCompact(taskId: string, focusTopic?: string): void {
    this.dependencies.manualCompactCoordinator.request(taskId, focusTopic);
  }

  public saveSessionUiState(sessionId: string, input: SaveSessionUiStateInput): void {
    this.dependencies.sessionUiStateService.save(sessionId, input);
  }

  public updateSessionTitle(sessionId: string, title: string): SessionRecord {
    return this.dependencies.sessionService.updateTitle(sessionId, title);
  }

  public resolveSessionRef(ref: string, ownerUserId: string): ResolveSessionRefResult {
    return resolveSessionRef(ref, ownerUserId, this.listSessions());
  }

  public branchSession(input: {
    agentProfileId: SessionRecord["agentProfileId"];
    cwd: string;
    ownerUserId: string;
    providerName?: string;
    sourceSessionId: string;
    title?: string;
  }): SessionRecord {
    return this.dependencies.sessionBranchService.branch({
      agentProfileId: input.agentProfileId,
      cwd: input.cwd,
      ownerUserId: input.ownerUserId,
      providerName: input.providerName ?? this.dependencies.provider.name,
      sourceSessionId: input.sourceSessionId,
      ...(input.title !== undefined ? { title: input.title } : {})
    });
  }

  public handoffSession(request: SessionHandoffRequest) {
    return this.dependencies.sessionHandoffService.handoff(request);
  }

  public rebindGatewaySession(input: {
    adapterId: string;
    externalSessionId: string;
    externalUserId?: string | null;
    ownerUserId: string;
    runtimeSessionId: string;
    runtimeUserId: string;
  }) {
    return this.dependencies.sessionHandoffService.rebindExternalSession(input);
  }

  public resolveGatewayRuntimeSessionId(adapterId: string, externalSessionId: string): string | null {
    const latest = this.dependencies.gatewaySessionRepository.findLatestByExternalSession(
      adapterId,
      externalSessionId
    );
    return latest?.runtimeSessionId ?? null;
  }

  public listGatewayBindingsForRuntimeSession(runtimeSessionId: string) {
    return this.dependencies.sessionHandoffService.listBindingsForSession(runtimeSessionId);
  }

  public listSessionIndex(query?: SessionListQuery): SessionIndexEntry[] {
    return this.dependencies.sessionIndexService.list(query);
  }

  public latestSessionIndexForUser(ownerUserId: string): SessionIndexEntry | null {
    return this.dependencies.sessionIndexService.latestForUser(ownerUserId);
  }

  public searchSessionMessages(input: {
    limit?: number;
    query: string;
    sessionIdPrefix?: string;
  }): SessionMessageSearchHit[] {
    return this.dependencies.sessionMessageSearchService.search(input);
  }

  public searchCuratedMemories(input: {
    limit?: number;
    query: string;
  }): Array<{ memory: MemoryRecord; score: number; provider: string }> {
    return this.dependencies.memoryPlane.searchMemories(input.query, input.limit ?? 5);
  }

  public async migrateLegacyTranscripts(): Promise<TranscriptMigrationResult> {
    return migrateLegacyTranscriptFiles({
      sessionRepository: {
        create: (draft) => this.dependencies.sessionService.createSession(draft),
        findById: (sessionId) => this.findSession(sessionId)
      },
      sessionUiStateService: this.dependencies.sessionUiStateService,
      workspaceRoot: this.dependencies.workspaceRoot
    });
  }

  public async repairLegacyWorkspace(): Promise<TranscriptMigrationResult & { remainingIssues: string[] }> {
    const transcript = await this.migrateLegacyTranscripts();
    this.dependencies.finalizeLegacyThreadSchema();
    return {
      ...transcript,
      remainingIssues: this.dependencies.collectLegacyWorkspaceIssues()
    };
  }

  public listSessions(status?: SessionRecord["status"]): SessionRecord[] {
    return this.sessionFacade.listSessions(status);
  }

  public findSession(sessionId: string): SessionRecord | null {
    return this.dependencies.findSession(sessionId);
  }

  public showSession(sessionId: string): {
    commitments: CommitmentRecord[];
    inboxItems: InboxItem[];
    nextActions: NextActionRecord[];
    state: SessionCommitmentState;
    session: SessionRecord | null;
    tasks: SessionTaskRecord[];
    lineage: SessionLineageRecord[];
    scheduleRuns: ScheduleRunRecord[];
  } {
    return this.sessionFacade.showSession(sessionId);
  }

  public archiveSession(sessionId: string): SessionRecord {
    return this.sessionFacade.archiveSession(sessionId);
  }

  public listSessionSummaries(sessionId: string): SessionSummaryRecord[] {
    return this.sessionFacade.listSessionSummaries(sessionId);
  }

  public showSessionSummary(snapshotId: string): SessionSummaryRecord | null {
    return this.sessionFacade.showSessionSummary(snapshotId);
  }

  public searchSessionSummaries(input: {
    limit: number;
    query: string;
    sessionId?: string;
    excludeSessionId?: string | null;
  }): SessionSearchHit[] {
    return this.sessionFacade.searchSessionSummaries(input);
  }

  public ensureRuntimeSession(
    sessionId: string,
    input?: {
      agentProfileId?: SessionRecord["agentProfileId"];
      cwd?: string;
      ownerUserId?: string;
      title?: string;
    }
  ): SessionRecord {
    return this.sessionFacade.ensureRuntimeSession(sessionId, input);
  }

  public async continueSession(
    sessionId: string,
    input: string,
    overrides?: Partial<RuntimeRunOptions>
  ): Promise<RunTaskResult> {
    return this.sessionFacade.continueSession(sessionId, input, overrides);
  }

  public startSessionTurn(
    sessionId: string,
    input: string,
    overrides?: Partial<RuntimeRunOptions>
  ): { done: Promise<RunTaskResult>; taskId: string } {
    const taskId = overrides?.taskId ?? randomUUID();
    return {
      done: this.continueSession(sessionId, input, { ...overrides, taskId }),
      taskId
    };
  }

  public async continueLatest(
    input: string | undefined,
    overrides?: Partial<RuntimeRunOptions>
  ): Promise<RunTaskResult> {
    return this.sessionFacade.continueLatest(input, overrides);
  }

  public listCommitments(query: CommitmentListQuery = {}): CommitmentRecord[] {
    return this.dependencies.commitmentService.list(query);
  }

  public showCommitment(commitmentId: string): CommitmentRecord | null {
    return this.dependencies.commitmentService.get(commitmentId);
  }

  public createCommitment(draft: CommitmentDraft): CommitmentRecord {
    return this.dependencies.commitmentService.create(draft);
  }

  public updateCommitment(commitmentId: string, patch: Parameters<CommitmentService["update"]>[1]): CommitmentRecord {
    return this.dependencies.commitmentService.update(commitmentId, patch);
  }

  public blockCommitment(commitmentId: string, reason: string): CommitmentRecord {
    return this.dependencies.commitmentService.block(commitmentId, reason);
  }

  public unblockCommitment(commitmentId: string): CommitmentRecord {
    return this.dependencies.commitmentService.unblock(commitmentId);
  }

  public completeCommitment(commitmentId: string): CommitmentRecord {
    return this.dependencies.commitmentService.complete(commitmentId);
  }

  public cancelCommitment(commitmentId: string): CommitmentRecord {
    return this.dependencies.commitmentService.cancel(commitmentId);
  }

  public listNextActions(query: NextActionListQuery = {}): NextActionRecord[] {
    return this.dependencies.nextActionService.list(query);
  }

  public appendNextAction(draft: NextActionDraft): NextActionRecord {
    return this.dependencies.nextActionService.create(draft);
  }

  public markNextActionDone(nextActionId: string): NextActionRecord {
    return this.dependencies.nextActionService.markDone(nextActionId);
  }

  public blockNextAction(nextActionId: string, reason: string): NextActionRecord {
    return this.dependencies.nextActionService.block(nextActionId, reason);
  }

  public unblockNextAction(nextActionId: string): NextActionRecord {
    return this.dependencies.nextActionService.unblock(nextActionId);
  }

  public cancelNextAction(nextActionId: string): NextActionRecord {
    return this.dependencies.nextActionService.cancel(nextActionId);
  }

  public reorderNextActions(sessionId: string, orderedIds: string[]): NextActionRecord[] {
    return this.dependencies.nextActionService.reorder(sessionId, orderedIds);
  }

  public listMemories(): MemoryRecord[] {
    return this.dependencies.listMemories();
  }

  public listExperiences(query?: ExperienceQuery): ExperienceRecord[] {
    return this.dependencies.experiencePlane.list(query);
  }

  public showExperience(experienceId: string): ExperienceRecord | null {
    return this.dependencies.experiencePlane.show(experienceId);
  }

  public reviewExperience(request: ExperienceReviewRequest): ExperienceRecord {
    return this.dependencies.experiencePlane.review(request);
  }

  public promoteExperience(
    request: Parameters<ExperiencePlane["promote"]>[0]
  ): ExperiencePromoteResult {
    return this.dependencies.experiencePlane.promote(request);
  }

  public searchExperiences(query: string, filters: ExperienceQuery = {}) {
    return this.dependencies.experiencePlane.search(query, filters);
  }

  public listSkills() {
    return this.dependencies.skillRegistry.listSkills();
  }

  public viewSkill(skillId: string, attachmentKinds: SkillAttachmentKind[] = []) {
    return this.dependencies.skillRegistry.viewSkill(skillId, attachmentKinds);
  }

  public enableSkill(skillId: string) {
    return this.dependencies.skillRegistry.enableSkill(skillId);
  }

  public disableSkill(skillId: string) {
    return this.dependencies.skillRegistry.disableSkill(skillId);
  }

  public listTools() {
    return this.dependencies.toolOverrideStore.listTools(this.dependencies.toolRegistry.list());
  }

  public enableTool(toolName: string) {
    return this.dependencies.toolOverrideStore.enableTool(toolName, this.dependencies.toolRegistry.list());
  }

  public disableTool(toolName: string) {
    return this.dependencies.toolOverrideStore.disableTool(toolName, this.dependencies.toolRegistry.list());
  }

  public createSkillDraftFromExperience(experienceId: string) {
    const experience = this.dependencies.experiencePlane.show(experienceId);
    if (experience === null) {
      throw new Error(`Experience ${experienceId} was not found.`);
    }
    return this.dependencies.skillDraftManager.createDraftFromExperience(experience);
  }

  public promoteSkillDraft(draftId: string, target: "project" | "user" | "team" = "project") {
    return this.dependencies.skillDraftManager.promoteDraft(draftId, target);
  }

  public rollbackSkillPromotion(skillId: string, reason: string) {
    return this.dependencies.skillDraftManager.rollbackPromotion(skillId, reason);
  }

  public listSkillVersions(skillId: string) {
    return this.dependencies.skillDraftManager.listVersions(skillId);
  }

  public showMemoryScope(scope: MemoryScope, scopeKey: string): {
    memories: MemoryRecord[];
    snapshots: MemorySnapshotRecord[];
  } {
    if (scope === "working") {
      const checkpoint = this.dependencies.findExecutionCheckpoint(scopeKey);
      return {
        memories:
          checkpoint?.memoryContext.map((fragment) =>
            contextFragmentToMemoryRecord(fragment, scopeKey, checkpoint.updatedAt)
          ) ?? [],
        snapshots: []
      };
    }
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
    status: "verified" | "rejected" | "stale" | "archived",
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

  public addMemory(input: {
    content: string;
    cwd: string;
    profileId: string;
    reviewerId: string;
    scope: "profile" | "project";
    userId: string;
  }): MemoryRecord {
    const content = input.content.trim();
    if (content.length === 0) {
      throw new Error("Memory content must not be empty.");
    }

    const scopeKey =
      input.scope === "project" ? input.cwd : `${input.userId}:${input.profileId}`;
    const summary = summarizeText(content, 160);
    const title = summarizeText(content, 80);
    const keywords = extractMemoryKeywords(content);
    const memory = this.dependencies.memoryPlane.writeMemory({
      confidence: 0.95,
      content,
      expiresAt: null,
      keywords,
      metadata: {
        createdBy: input.reviewerId,
        creationSurface: "manual_add"
      },
      privacyLevel: "internal",
      retentionPolicy: {
        kind: input.scope,
        reason: `Manual memory added by ${input.reviewerId}.`,
        ttlDays: 90
      },
      scope: input.scope,
      scopeKey,
      source: {
        label: `Manual memory added by ${input.reviewerId}`,
        sourceType: "manual_review",
        taskId: null,
        toolCallId: null,
        traceEventId: null
      },
      status: "verified",
      tier: "core",
      summary,
      title
    });

    if (memory === null) {
      throw new Error("Memory write was rejected by policy.");
    }

    return memory;
  }

  public forgetMemory(memoryId: string, reviewerId: string, note: string): MemoryRecord {
    return this.reviewMemory(memoryId, "archived", reviewerId, note);
  }

  public resolveMemoryConflict(input: {
    keepMemoryId: string;
    archiveMemoryId: string;
    reviewerId: string;
    note?: string;
  }): { kept: MemoryRecord; archived: MemoryRecord } {
    return this.dependencies.memoryPlane.resolveConflict(input);
  }

  public explainMemoryRecall(taskId: string, memoryId?: string): {
    entries: Array<{
      blocked: boolean;
      confidence: number;
      downrankReasons: string[];
      explanation: string;
      filterReason: string | null;
      filterReasonCode: string | null;
      memoryId: string;
      selected: boolean;
      status: string;
      title: string;
    }>;
    query: string;
    selectedMemoryIds: string[];
    taskId: string;
  } | null {
    const payload = this.traceTaskContext(taskId).memoryRecall;
    if (payload === null) {
      return null;
    }

    const entries =
      memoryId === undefined
        ? payload.entries
        : payload.entries.filter((entry) => entry.memoryId === memoryId);
    return {
      entries: entries.map((entry) => ({
        blocked: entry.blocked,
        confidence: entry.confidence,
        downrankReasons: entry.downrankReasons,
        explanation: entry.explanation,
        filterReason: entry.filterReason,
        filterReasonCode: entry.filterReasonCode,
        memoryId: entry.memoryId,
        selected: entry.selected,
        status: entry.status,
        title: entry.title
      })),
      query: payload.query,
      selectedMemoryIds: payload.selectedMemoryIds,
      taskId
    };
  }

  public getLongTermMemoryStatus(cwd: string): { enabled: boolean; configPath: string } {
    const config = resolveRuntimeConfig(cwd);
    return { enabled: config.memory.enabled, configPath: config.configPath };
  }

  public setLongTermMemoryEnabled(cwd: string, enabled: boolean): {
    enabled: boolean;
    configPath: string;
  } {
    const configPath = writeMemoryEnabled(cwd, enabled);
    return { enabled, configPath };
  }
  public listMemorySuggestions(query: {
    limit?: number;
    status?: InboxItem["status"];
    userId?: string;
  } = {}): InboxItem[] {
    return this.dependencies.listInboxItems({
      category: "memory_suggestion",
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.userId !== undefined ? { userId: query.userId } : {})
    });
  }

  public acceptMemorySuggestion(inboxId: string, reviewerId: string): {
    inboxItem: InboxItem;
    memory: MemoryRecord | null;
  } {
    const item = this.requireMemorySuggestion(inboxId);
    const action = item.metadata.action;
    const memory = action === "replace" || action === "remove"
      ? this.applyMemoryMutationSuggestion(item, reviewerId, action)
      : (() => {
          const draft = parseMemorySuggestionDraft(item.metadata);
          return draft === null
            ? this.restoreExistingSuggestedMemory(item)
            : this.dependencies.memoryPlane.writeMemory({
                confidence: draft.confidence,
                content: draft.content,
                expiresAt: null,
                keywords: draft.keywords,
                metadata: {
                  ...draft.metadata,
                  acceptedFromInboxId: item.inboxId,
                  acceptedBy: reviewerId
                },
                privacyLevel: draft.privacyLevel,
                retentionPolicy: draft.retentionPolicy,
                scope: draft.scope,
                scopeKey: draft.scopeKey,
                source: draft.source,
                status: "verified",
                tier: "core",
                summary: draft.summary,
                title: draft.title
              });
        })();
    const done = this.dependencies.inboxService.markDone(inboxId, reviewerId);
    return { inboxItem: done, memory };
  }

  public dismissMemorySuggestion(inboxId: string): InboxItem {
    this.requireMemorySuggestion(inboxId);
    return this.dependencies.inboxService.markDismissed(inboxId);
  }

  public listPendingApprovals(): ApprovalRecord[] {
    this.reconcileExpiredApprovals();
    return this.dependencies.listPendingApprovals();
  }

  public listPendingClarifyPrompts(): ClarifyPromptRecord[] {
    this.reconcileExpiredApprovals();
    return this.dependencies.listPendingClarifyPrompts();
  }

  public async resolveApproval(
    approvalId: string,
    action: "allow" | "deny",
    reviewerId: string,
    allowScope?: ApprovalAllowScope,
    resumeOptions?: {
      onOutputEvent?: (event: RuntimeOutputEvent) => void;
      signal?: AbortSignal;
    }
  ): Promise<ApprovalActionResult> {
    this.reconcileExpiredApprovals();
    return this.approvalResolutionFacade.resolveApproval(
      approvalId,
      action,
      reviewerId,
      allowScope,
      resumeOptions
    );
  }

  public async answerClarifyPrompt(
    promptId: string,
    reviewerId: string,
    input: {
      answerOptionId?: string;
      answerText?: string;
      answers?: Record<string, string | string[]>;
      response?: string;
    },
    resumeOptions?: {
      onOutputEvent?: (event: RuntimeOutputEvent) => void;
      signal?: AbortSignal;
    }
  ): Promise<ClarifyActionResult> {
    this.reconcileExpiredApprovals();
    return this.clarifyResolutionFacade.answerClarifyPrompt(promptId, reviewerId, input, resumeOptions);
  }

  public cancelClarifyPrompt(promptId: string, reviewerId: string): ClarifyActionResult {
    this.reconcileExpiredApprovals();
    return this.clarifyResolutionFacade.cancelClarifyPrompt(promptId, reviewerId);
  }

  public showTask(taskId: string): {
    approvals: ApprovalRecord[];
    artifacts: ArtifactRecord[];
    inboxItems: InboxItem[];
    scheduleRuns: ScheduleRunRecord[];
    task: TaskRecord | null;
    toolCalls: ToolCallRecord[];
    output: RuntimeOutputEvent[];
    trace: TraceEvent[];
  } {
    const task = this.dependencies.findTask(taskId);

    return {
      approvals: task === null ? [] : this.dependencies.listApprovals(taskId),
      artifacts: task === null ? [] : this.dependencies.listArtifacts(taskId),
      inboxItems: task === null ? [] : this.dependencies.listInboxItems({ taskId }),
      scheduleRuns: task === null ? [] : this.dependencies.listScheduleRunsByTask(taskId),
      task,
      toolCalls: task === null ? [] : this.dependencies.listToolCalls(taskId),
      output: task === null ? [] : this.dependencies.listOutputEvents(taskId),
      trace: task === null ? [] : this.dependencies.listTrace(taskId)
    };
  }

  public listInbox(query: InboxListQuery = {}): InboxItem[] {
    return this.dependencies.listInboxItems(query);
  }

  public showInboxItem(inboxId: string): InboxItem | null {
    return this.dependencies.findInboxItem(inboxId);
  }

  public markInboxDone(inboxId: string, reviewerUserId: string): InboxItem {
    return this.dependencies.inboxService.markDone(inboxId, reviewerUserId);
  }

  public markInboxDismissed(inboxId: string): InboxItem {
    return this.dependencies.inboxService.markDismissed(inboxId);
  }

  public subscribeInbox(
    filter: InboxListQuery,
    listener: (event: InboxDeliveryEvent) => void
  ): () => void {
    return this.dependencies.inboxService.subscribe(filter, listener);
  }

  public startScheduler(): void {
    this.scheduleFacade.startScheduler();
  }

  public stopScheduler(): void {
    this.scheduleFacade.stopScheduler();
  }

  public createSchedule(input: CreateScheduleInput): ScheduleRecord {
    return this.scheduleFacade.createSchedule(input);
  }

  public updateSchedule(scheduleId: string, input: UpdateScheduleInput): ScheduleRecord {
    return this.scheduleFacade.updateSchedule(scheduleId, input);
  }

  public listSchedules(query?: ScheduleListQuery): ScheduleRecord[] {
    return this.scheduleFacade.listSchedules(query);
  }

  public showSchedule(scheduleId: string): ScheduleRecord | null {
    return this.scheduleFacade.showSchedule(scheduleId);
  }

  public listScheduleRuns(scheduleId: string, query?: ScheduleRunListQuery): ScheduleRunRecord[] {
    return this.scheduleFacade.listScheduleRuns(scheduleId, query);
  }

  public scheduleStatus(): ReturnType<SchedulerService["status"]> {
    return this.scheduleFacade.scheduleStatus();
  }

  public async tickScheduleOnce(): Promise<void> {
    await this.scheduleFacade.tickScheduleOnce();
  }

  public archiveSchedule(scheduleId: string): ScheduleRecord {
    return this.scheduleFacade.archiveSchedule(scheduleId);
  }

  public pauseSchedule(scheduleId: string): ScheduleRecord {
    return this.scheduleFacade.pauseSchedule(scheduleId);
  }

  public resumeSchedule(scheduleId: string): ScheduleRecord {
    return this.scheduleFacade.resumeSchedule(scheduleId);
  }

  public runScheduleNow(scheduleId: string): ScheduleRunRecord {
    return this.scheduleFacade.runScheduleNow(scheduleId);
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

  public listConfiguredProviders(): ConfiguredProviderEntry[] {
    return listConfiguredProviders(this.dependencies.workspaceRoot);
  }

  public modelSelectionView(sessionId?: string): ModelSelectionView {
    return this.providerSwitchFacade.modelSelectionView(sessionId);
  }

  public async setSessionModelSelection(input: {
    selection: string;
    sessionId: string;
  }): Promise<{ result: SwitchProviderResult; session: SessionRecord; view: ModelSelectionView }> {
    return this.providerSwitchFacade.setSessionModelSelection(input);
  }

  public async clearSessionModelSelection(
    sessionId: string
  ): Promise<{ result: SwitchProviderResult | null; session: SessionRecord; view: ModelSelectionView }> {
    return this.providerSwitchFacade.clearSessionModelSelection(sessionId);
  }

  public async switchProvider(input: {
    persist: ProviderSwitchPersistScope;
    selection: string;
    sessionId?: string;
  }): Promise<SwitchProviderResult> {
    return this.providerSwitchFacade.switchProvider(input);
  }
  public providerStats(groupBy: "provider" | "session" | "task" | "mode" = "provider"): ProviderStatsSnapshot | null | JsonObject {
    return new ProviderStatsService({
      listTasks: () => this.dependencies.listTasks(),
      listTrace: (taskId) => this.dependencies.listTrace(taskId),
      provider: this.dependencies.provider
    }).providerStats(groupBy);
  }

  public budgetReport(scope: "task" | "session", id: string): Record<string, unknown> {
    const state =
      scope === "task"
        ? this.dependencies.budgetService?.getTaskState(id)
        : this.dependencies.budgetService?.getSessionState(id);
    return {
      scope,
      id,
      state: state ?? null
    };
  }

  public setRoutingMode(mode: "cheap_first" | "balanced" | "quality_first"): void {
    this.dependencies.providerRouter?.setMode(mode);
    this.dependencies.auditService.record({
      action: "route_decided",
      actor: "runtime.application",
      approvalId: null,
      outcome: "succeeded",
      payload: { mode },
      summary: `Routing mode set to ${mode}`,
      taskId: null,
      toolCallId: null
    });
  }

  public traceTask(taskId: string): TraceEvent[] {
    return this.dependencies.listTrace(taskId);
  }

  public outputTask(taskId: string): RuntimeOutputEvent[] {
    return this.dependencies.listOutputEvents(taskId);
  }

  public outputSession(sessionId: string): RuntimeOutputEvent[] {
    return this.dependencies.listSessionOutputEvents(sessionId);
  }

  public subscribeToTaskOutput(
    taskId: string,
    listener: (event: RuntimeOutputEvent) => void
  ): () => void {
    return this.dependencies.outputService.subscribe((event) => {
      if (event.taskId === taskId) {
        listener(event);
      }
    });
  }

  public taskTimeline(taskId: string): TaskTimelineReport {
    const task = this.dependencies.findTask(taskId);
    const trace = task === null ? [] : this.dependencies.listTrace(taskId);

    return {
      entries: trace
        .filter((event) =>
          [
            "task_started",
            "repo_map_created",
            "provider_request_started",
            "provider_request_succeeded",
            "provider_request_failed",
            "tool_call_requested",
            "tool_call_finished",
            "tool_call_failed",
            "approval_requested",
            "approval_resolved",
            "retry",
            "loop_iteration_completed",
            "final_outcome"
          ].includes(event.eventType)
        )
        .map((event) => ({
          actor: event.actor,
          detail: event.summary,
          eventType: event.eventType,
          iteration: extractTimelineIteration(event),
          sequence: event.sequence,
          stage: event.stage,
          timestamp: event.timestamp
        })),
      task
    };
  }

  public subscribeToTaskTrace(taskId: string, listener: (event: TraceEvent) => void): () => void {
    return this.dependencies.traceService.subscribe((event) => {
      if (event.taskId === taskId) {
        listener(event);
      }
    });
  }

  private releaseSessionLockIfTerminal(task: TaskRecord): void {
    if (task.sessionId === null || task.sessionId === undefined || !isTerminalTaskStatus(task.status)) {
      return;
    }
    this.dependencies.sessionExecutionLock.release(task.sessionId, task.taskId);
  }

  private projectAssistantOutput(
    sessionId: string | null,
    taskId: string,
    output: string | null
  ): void {
    if (sessionId === null || output === null || output.trim().length === 0) {
      return;
    }
    this.dependencies.assistantSessionProjectionService.project({
      output,
      taskId,
      sessionId
    });
  }

  private requireMemorySuggestion(inboxId: string): InboxItem {
    const item = this.dependencies.findInboxItem(inboxId);
    if (item === null) {
      throw new Error(`Inbox item ${inboxId} was not found.`);
    }
    if (item.category !== "memory_suggestion") {
      throw new Error(`Inbox item ${inboxId} is not a memory suggestion.`);
    }
    return item;
  }

  private applyMemoryMutationSuggestion(
    item: InboxItem,
    reviewerId: string,
    action: "replace" | "remove"
  ): MemoryRecord | null {
    const targetMemoryId = typeof item.metadata.targetMemoryId === "string"
      ? item.metadata.targetMemoryId
      : null;
    if (targetMemoryId === null) {
      throw new Error("Memory suggestion has no target memory.");
    }
    const current = this.dependencies.findMemory(targetMemoryId);
    if (current === null || current.status === "archived") {
      throw new Error(`Target memory ${targetMemoryId} is no longer active.`);
    }
    if (action === "remove") {
      return this.dependencies.memoryPlane.reviewMemory({
        memoryId: current.memoryId,
        reviewerId,
        status: "archived",
        note: `Accepted remove suggestion ${item.inboxId}`
      });
    }
    const oldText = typeof item.metadata.oldText === "string" ? item.metadata.oldText : "";
    const replacement = typeof item.metadata.content === "string" ? item.metadata.content : "";
    if (oldText.length === 0 || current.content.split(oldText).length !== 2) {
      throw new Error("Replace suggestion no longer has a unique substring match.");
    }
    const content = current.content.replace(oldText, replacement);
    const created = this.dependencies.memoryPlane.writeMemory({
      confidence: Math.max(current.confidence, 0.9),
      content,
      expiresAt: current.expiresAt,
      keywords: extractMemoryKeywords(content),
      metadata: {
        ...current.metadata,
        acceptedFromInboxId: item.inboxId,
        acceptedBy: reviewerId
      },
      privacyLevel: current.privacyLevel,
      retentionPolicy: current.retentionPolicy,
      scope: current.scope,
      scopeKey: current.scopeKey,
      source: {
        label: `Accepted replace suggestion ${item.inboxId}`,
        sourceType: "manual_review",
        taskId: item.taskId,
        toolCallId: null,
        traceEventId: null
      },
      status: "verified",
      tier: "core",
      summary: summarizeText(content, 160),
      supersedes: current.memoryId,
      title: summarizeText(content, 80)
    });
    if (created === null) {
      throw new Error("Replacement memory was rejected by policy; original memory was preserved.");
    }
    this.dependencies.memoryPlane.reviewMemory({
      memoryId: current.memoryId,
      reviewerId,
      status: "archived",
      note: `Superseded by ${created.memoryId}`
    });
    return created;
  }
  private restoreExistingSuggestedMemory(item: InboxItem): MemoryRecord | null {
    const promotedMemoryId = typeof item.metadata.promotedMemoryId === "string" ? item.metadata.promotedMemoryId : null;
    if (promotedMemoryId === null) {
      return null;
    }
    const existing = this.dependencies.findMemory(promotedMemoryId);
    if (existing === null) {
      throw new Error(`Suggested memory ${promotedMemoryId} was not found.`);
    }
    return existing;
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
    const latestSessionSummary = [...trace]
      .reverse()
      .find(
        (event): event is Extract<TraceEvent, { eventType: "session_summary_written" }> =>
          event.eventType === "session_summary_written"
      )?.payload ?? null;

    return {
      contextAssembly,
      latestSessionSummary,
      memoryRecall,
      reviewerTrace,
      task
    };
  }

  public auditTask(taskId: string): AuditLogRecord[] {
    return this.dependencies.listAuditLogs(taskId);
  }

  public async rollbackFileArtifact(
    artifactId: string
  ): Promise<RollbackFileArtifactResult> {
    return new FileRollbackService({
      auditService: this.dependencies.auditService,
      findArtifact: (id) => this.dependencies.findArtifact(id),
      findLatestArtifactByType: (artifactType) =>
        this.dependencies.findLatestArtifactByType(artifactType),
      traceService: this.dependencies.traceService
    }).rollbackFileArtifact(artifactId);
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
    const report = await new RuntimeDoctorService({
      allowedFetchHosts: this.dependencies.allowedFetchHosts,
      databasePath: this.dependencies.databasePath,
      listExperiences: () => this.dependencies.listExperiences(),
      providerConfig: this.dependencies.providerConfig,
      providerName: this.dependencies.provider.name,
      runtimeConfigPath: this.dependencies.runtimeConfigPath,
      runtimeConfigSource: this.dependencies.runtimeConfigSource,
      runtimeVersion: this.dependencies.runtimeVersion,
      customShell: this.dependencies.customShell,
      maxShellTimeoutMs: this.dependencies.maxShellTimeoutMs,
      shellBackend: this.dependencies.shellBackend,
      skillStats: () => this.dependencies.skillRegistry.listSkills(),
      testCommands: this.dependencies.testCommands,
      testCurrentProvider: (providerSignal) => this.testCurrentProvider(providerSignal),
      tokenBudget: this.dependencies.tokenBudget,
      deprecatedCompactBufferTokens: this.dependencies.compact.bufferTokens,
      workspaceRoot: this.dependencies.workspaceRoot
    }).configDoctor(signal);
    const legacyIssues = this.dependencies.collectLegacyWorkspaceIssues();
    if (legacyIssues.length === 0) {
      return report;
    }
    return {
      ...report,
      issues: [...report.issues, ...legacyIssues]
    };
  }

  public async smokeCurrentProvider(signal?: AbortSignal): Promise<ProviderSmokeReport> {
    const startedAt = Date.now();
    const now = new Date().toISOString();
    const tokenBudget = {
      ...this.dependencies.tokenBudget,
      usedInput: 0,
      usedOutput: 0
    };
    const task: TaskRecord = {
      agentProfileId: "executor",
      createdAt: now,
      currentIteration: 2,
      cwd: this.dependencies.workspaceRoot,
      errorCode: null,
      errorMessage: null,
      finalOutput: null,
      finishedAt: null,
      input: "Provider smoke post-tool turn.",
      maxIterations: 2,
      metadata: { diagnostic: "provider_smoke" },
      providerName: this.dependencies.provider.name,
      requesterUserId: "provider-smoke",
      startedAt: now,
      status: "running",
      taskId: randomUUID(),
      tokenBudget,
      updatedAt: now
    };
    const controller = signal === undefined ? new AbortController() : null;

    try {
      await this.dependencies.provider.generate({
        agentProfileId: "executor",
        availableTools: [
          {
            capability: "filesystem.read",
            description: "Read a small workspace file.",
            inputSchema: {
              additionalProperties: false,
              properties: { path: { type: "string" } },
              required: ["path"],
              type: "object"
            },
            name: "read_file",
            privacyLevel: "internal",
            riskLevel: "low"
          }
        ],
        iteration: 2,
        memoryContext: [],
        messages: [
          {
            content: "Answer with a short acknowledgement after the tool result.",
            role: "system"
          },
          {
            content: "Read the project plan.",
            role: "user"
          },
          {
            content: "",
            role: "assistant",
            toolCalls: [
              {
                input: { path: "PLAN.md" },
                reason: "Provider smoke synthetic tool request.",
                toolCallId: "provider-smoke-file-read",
                toolName: "read_file"
              }
            ]
          },
          {
            content: '{"ok":true,"summary":"Synthetic provider smoke tool result."}',
            role: "tool",
            toolCallId: "provider-smoke-file-read",
            toolName: "read_file"
          }
        ],
        signal: signal ?? controller!.signal,
        task,
        tokenBudget
      });
      return {
        errorCategory: null,
        latencyMs: Date.now() - startedAt,
        message: "Synthetic post-tool turn completed.",
        modelName: this.dependencies.providerConfig.model,
        ok: true,
        providerName: this.dependencies.provider.name,
        streamIdleTimeoutMs: this.dependencies.providerConfig.streamIdleTimeoutMs,
        timeoutMs: this.dependencies.providerConfig.timeoutMs
      };
    } catch (error) {
      const providerError = error as { category?: string; message?: string };
      return {
        errorCategory: providerError.category ?? "unknown_error",
        latencyMs: Date.now() - startedAt,
        message: providerError.message ?? "Provider smoke failed.",
        modelName: this.dependencies.providerConfig.model,
        ok: false,
        providerName: this.dependencies.provider.name,
        streamIdleTimeoutMs: this.dependencies.providerConfig.streamIdleTimeoutMs,
        timeoutMs: this.dependencies.providerConfig.timeoutMs
      };
    }
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

      void this.approvalResolutionFacade.resumeApprovalFailureOnce(approval);
    }

    for (const prompt of this.dependencies.clarifyService.expirePending()) {
      this.dependencies.traceService.record({
        actor: "clarify.service",
        eventType: "clarify_resolved",
        payload: {
          promptId: prompt.promptId,
          status: "timed_out"
        },
        stage: "governance",
        summary: `Clarification timed out for task ${prompt.taskId}`,
        taskId: prompt.taskId
      });

      this.dependencies.updateToolCall(prompt.toolCallId, {
        errorCode: "approval_timeout",
        errorMessage: `Clarification prompt ${prompt.promptId} timed out.`,
        finishedAt: new Date().toISOString(),
        status: "timed_out"
      });

      this.dependencies.executionKernel.failWaitingClarificationTask(
        prompt.taskId,
        new AppError({
          code: "approval_timeout",
          message: `Clarification prompt ${prompt.promptId} timed out.`
        })
      );
    }
  }
}

interface MemorySuggestionDraftShape {
  confidence: number;
  content: string;
  keywords: string[];
  metadata: JsonObject;
  privacyLevel: "public" | "internal" | "restricted";
  retentionPolicy: MemoryRecord["retentionPolicy"];
  scope: "profile" | "project";
  scopeKey: string;
  source: MemoryRecord["source"];
  summary: string;
  title: string;
}

function extractTimelineIteration(event: TraceEvent): number | null {
  const payload = event.payload as { iteration?: unknown };
  return typeof payload.iteration === "number" ? payload.iteration : null;
}

function summarizeText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 3)}...`;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMemorySuggestionDraft(metadata: JsonObject): MemorySuggestionDraftShape | null {
  const raw = isJsonObject(metadata.memorySuggestionDraft)
    ? metadata.memorySuggestionDraft
    : isJsonObject(metadata.draft)
      ? metadata.draft
      : null;
  if (raw === null) {
    return null;
  }
  if (
    typeof raw.content !== "string" ||
    typeof raw.scope !== "string" ||
    typeof raw.scopeKey !== "string" ||
    typeof raw.title !== "string" ||
    typeof raw.summary !== "string" ||
    typeof raw.confidence !== "number" ||
    !Array.isArray(raw.keywords) ||
    typeof raw.privacyLevel !== "string" ||
    !isJsonObject(raw.source) ||
    !isJsonObject(raw.retentionPolicy)
  ) {
    return null;
  }
  return {
    confidence: raw.confidence,
    content: raw.content,
    keywords: raw.keywords.filter((entry): entry is string => typeof entry === "string"),
    metadata: isJsonObject(raw.metadata) ? raw.metadata : {},
    privacyLevel:
      raw.privacyLevel === "public" || raw.privacyLevel === "restricted"
        ? raw.privacyLevel
        : "internal",
    retentionPolicy: {
      kind:
        raw.retentionPolicy.kind === "profile" || raw.retentionPolicy.kind === "project"
          ? raw.retentionPolicy.kind
          : "project",
      reason:
        typeof raw.retentionPolicy.reason === "string"
          ? raw.retentionPolicy.reason
          : "Accepted from memory suggestion inbox item.",
      ttlDays:
        typeof raw.retentionPolicy.ttlDays === "number" || raw.retentionPolicy.ttlDays === null
          ? raw.retentionPolicy.ttlDays
          : 90
    },
    scope: raw.scope === "profile" ? "profile" : "project",
    scopeKey: raw.scopeKey,
    source: {
      label: typeof raw.source.label === "string" ? raw.source.label : "Memory suggestion inbox draft",
      sourceType:
        raw.source.sourceType === "manual_review" ||
        raw.source.sourceType === "tool_output" ||
        raw.source.sourceType === "system" ||
        raw.source.sourceType === "user_input" ||
        raw.source.sourceType === "final_output" ||
        raw.source.sourceType === "session_compact"
          ? raw.source.sourceType
          : "manual_review",
      taskId: typeof raw.source.taskId === "string" || raw.source.taskId === null ? raw.source.taskId : null,
      toolCallId:
        typeof raw.source.toolCallId === "string" || raw.source.toolCallId === null
          ? raw.source.toolCallId
          : null,
      traceEventId:
        typeof raw.source.traceEventId === "string" || raw.source.traceEventId === null
          ? raw.source.traceEventId
          : null
    },
    summary: raw.summary,
    title: raw.title
  };
}

function contextFragmentToMemoryRecord(
  fragment: ContextFragment,
  scopeKey: string,
  timestamp: string
): MemoryRecord {
  return {
    confidence: fragment.confidence,
    conflictsWith: [],
    content: fragment.text,
    createdAt: timestamp,
    expiresAt: null,
    keywords: [],
    lastVerifiedAt: null,
    memoryId: fragment.memoryId,
    metadata: {
      explanation: fragment.explanation,
      runtimeOnly: true
    },
    privacyLevel: fragment.privacyLevel,
    retentionPolicy: fragment.retentionPolicy,
    scope: "working",
    scopeKey,
    source: {
      label: "runtime checkpoint fragment",
      sourceType: fragment.sourceType,
      taskId: scopeKey,
      toolCallId: null,
      traceEventId: null
    },
    sourceType: fragment.sourceType,
    status: fragment.status,
    tier: "retrieval",
    summary: fragment.text,
    supersedes: null,
    title: fragment.title,
    updatedAt: timestamp
  };
}


