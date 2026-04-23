import { existsSync, readFileSync, statSync, promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import type { ApprovalService } from "../approvals/approval-service.js";
import type { AuditService } from "../audit/audit-service.js";
import type {
  ExperiencePlane,
  ExperiencePromoteResult,
  ExperienceReviewRequest
} from "../experience/experience-plane.js";
import type { ProviderCatalogEntry, ResolvedProviderConfig } from "../providers/index.js";
import type {
  ApprovalRecord,
  ArtifactRecord,
  AuditLogRecord,
  ExperienceQuery,
  ExperienceRecord,
  InboxDeliveryEvent,
  InboxItem,
  InboxListQuery,
  JsonObject,
  MemoryRecord,
  MemoryScope,
  MemorySnapshotRecord,
  Provider,
  ProviderStatsSnapshot,
  ProviderHealthCheck,
  ProviderUsage,
  RuntimeRunOptions,
  ScheduleListQuery,
  ScheduleRecord,
  ScheduleRunListQuery,
  ScheduleRunRecord,
  TaskRecord,
  ThreadLineageRecord,
  ThreadRecord,
  ThreadRunRecord,
  ThreadSnapshotRecord,
  TraceEvent,
  ToolCallRecord
} from "../types/index.js";
import type { TraceService } from "../tracing/trace-service.js";
import type { MemoryPlane } from "../memory/memory-plane.js";
import type { SkillAttachmentKind } from "../types/skill.js";
import type { SkillDraftManager, SkillRegistry } from "../skills/index.js";
import type { ExecutionKernel } from "./execution-kernel.js";
import type { ResumePacketBuilder, ThreadService } from "./threads/index.js";
import type { CreateScheduleInput, SchedulerService } from "./scheduler/index.js";
import type { InboxService } from "./inbox/index.js";

import { AppError, toAppError } from "./app-error.js";

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

export interface AgentDoctorReport {
  apiKeyConfigured: boolean;
  configPath: string;
  configSource: "defaults" | "env" | "file";
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
  databaseReachable: boolean;
  distFresh: boolean | null;
  schemaVersion: number | null;
  shell: string | undefined;
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
  latestThreadSnapshot:
    | Extract<TraceEvent, { eventType: "thread_snapshot_created" }>["payload"]
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
  listArtifacts(taskId: string): ArtifactRecord[];
  listAuditLogs(taskId: string): AuditLogRecord[];
  listExperiences(): ExperienceRecord[];
  listMemorySnapshots(scope: MemoryScope, scopeKey: string): MemorySnapshotRecord[];
  listPendingApprovals(): ApprovalRecord[];
  listMemories(): MemoryRecord[];
  listTasks(): TaskRecord[];
  listThreadLineage(threadId: string): ThreadLineageRecord[];
  listThreadRuns(threadId: string): ThreadRunRecord[];
  listThreadSnapshots(threadId: string): ThreadSnapshotRecord[];
  findThreadSnapshot(snapshotId: string): ThreadSnapshotRecord | null;
  listSchedules(query?: ScheduleListQuery): ScheduleRecord[];
  findSchedule(scheduleId: string): ScheduleRecord | null;
  listScheduleRuns(scheduleId: string, query?: ScheduleRunListQuery): ScheduleRunRecord[];
  listScheduleRunsByTask(taskId: string): ScheduleRunRecord[];
  listScheduleRunsByThread(threadId: string): ScheduleRunRecord[];
  listInboxItems(query?: InboxListQuery): InboxItem[];
  findInboxItem(inboxId: string): InboxItem | null;
  listThreads(): ThreadRecord[];
  findThread(threadId: string): ThreadRecord | null;
  listToolCalls(taskId: string): ToolCallRecord[];
  listTrace(taskId: string): TraceEvent[];
  updateToolCall(toolCallId: string, patch: Partial<ToolCallRecord>): ToolCallRecord;
}

export interface AgentApplicationServiceDependencies extends RuntimeReadModel {
  approvalService: ApprovalService;
  auditService: AuditService;
  databasePath: string;
  executionKernel: ExecutionKernel;
  schedulerService: SchedulerService;
  resumePacketBuilder: ResumePacketBuilder;
  threadService: ThreadService;
  experiencePlane: ExperiencePlane;
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
  inboxService: InboxService;
  tokenBudget: {
    inputLimit: number;
    outputLimit: number;
    reservedOutput: number;
  };
  traceService: TraceService;
  workspaceRoot: string;
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

const approvalActionSchema = z.object({
  action: z.enum(["allow", "deny"]),
  approvalId: z.string().min(1),
  reviewerId: z.string().min(1)
});

export class AgentApplicationService {
  public constructor(private readonly dependencies: AgentApplicationServiceDependencies) {}

  public async runTask(options: RuntimeRunOptions): Promise<RunTaskResult> {
    try {
      const resolvedThread = this.dependencies.threadService.getOrCreateThread({
        agentProfileId: options.agentProfileId,
        cwd: options.cwd,
        ownerUserId: options.userId,
        providerName: this.dependencies.provider.name,
        ...(options.threadId !== undefined ? { threadId: options.threadId } : {}),
        title: options.taskInput.slice(0, 80)
      });
      const result = await this.dependencies.executionKernel.run({
        ...options,
        threadId: resolvedThread.threadId
      });
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

  public listThreads(status?: ThreadRecord["status"]): ThreadRecord[] {
    const threads = this.dependencies.listThreads();
    if (status === undefined) {
      return threads;
    }
    return threads.filter((thread) => thread.status === status);
  }

  public showThread(threadId: string): {
    inboxItems: InboxItem[];
    thread: ThreadRecord | null;
    runs: ThreadRunRecord[];
    lineage: ThreadLineageRecord[];
    scheduleRuns: ScheduleRunRecord[];
  } {
    const thread = this.dependencies.findThread(threadId);
    if (thread === null) {
      return { thread: null, runs: [], lineage: [], scheduleRuns: [], inboxItems: [] };
    }
    return {
      inboxItems: this.dependencies.listInboxItems({ threadId }),
      thread,
      runs: this.dependencies.listThreadRuns(threadId),
      lineage: this.dependencies.listThreadLineage(threadId),
      scheduleRuns: this.dependencies.listScheduleRunsByThread(threadId)
    };
  }

  public archiveThread(threadId: string): ThreadRecord {
    return this.dependencies.threadService.archiveThread(threadId);
  }

  public listThreadSnapshots(threadId: string): ThreadSnapshotRecord[] {
    return this.dependencies.listThreadSnapshots(threadId);
  }

  public showThreadSnapshot(snapshotId: string): ThreadSnapshotRecord | null {
    return this.dependencies.findThreadSnapshot(snapshotId);
  }

  public async continueThread(
    threadId: string,
    input: string,
    overrides?: Partial<RuntimeRunOptions>
  ): Promise<RunTaskResult> {
    const options = this.dependencies.resumePacketBuilder.buildResumePacket(threadId, input, overrides);
    return this.runTask(options);
  }

  public async continueLatest(
    input: string,
    overrides?: Partial<RuntimeRunOptions>
  ): Promise<RunTaskResult> {
    const ownerUserId = overrides?.userId ?? process.env.USERNAME ?? process.env.USER ?? "local-user";
    const latest = this.dependencies.threadService.findLatestThread(ownerUserId);
    if (latest === null) {
      throw new Error("No threads found for current user.");
    }
    return this.continueThread(latest.threadId, input, overrides);
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

  public createSkillDraftFromExperience(experienceId: string) {
    const experience = this.dependencies.experiencePlane.show(experienceId);
    if (experience === null) {
      throw new Error(`Experience ${experienceId} was not found.`);
    }
    return this.dependencies.skillDraftManager.createDraftFromExperience(experience);
  }

  public promoteSkillDraft(draftId: string) {
    return this.dependencies.skillDraftManager.promoteDraft(draftId);
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
    this.dependencies.traceService.record({
      actor: `reviewer.${reviewerId}`,
      eventType: "review_resolved",
      payload: {
        approvalId: approval.approvalId,
        reviewerId: approval.reviewerId,
        status: approval.status,
        toolCallId: approval.toolCallId,
        toolName: approval.toolName
      },
      stage: "lifecycle",
      summary: `Review resolved for ${approval.toolName}`,
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
      try {
        const result = await this.dependencies.executionKernel.resumeTask(approval.taskId);
        return {
          approval,
          output: result.output,
          task: result.task
        };
      } catch (error) {
        const appError = toAppError(error);
        const task = this.dependencies.findTask(approval.taskId);
        if (task === null) {
          throw appError;
        }

        return {
          approval,
          error: appError,
          output: null,
          task
        };
      }
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
    inboxItems: InboxItem[];
    scheduleRuns: ScheduleRunRecord[];
    task: TaskRecord | null;
    toolCalls: ToolCallRecord[];
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
    this.dependencies.schedulerService.start();
  }

  public stopScheduler(): void {
    this.dependencies.schedulerService.stop();
  }

  public createSchedule(input: CreateScheduleInput): ScheduleRecord {
    return this.dependencies.schedulerService.createSchedule(input);
  }

  public listSchedules(query?: ScheduleListQuery): ScheduleRecord[] {
    return this.dependencies.schedulerService.listSchedules(query);
  }

  public showSchedule(scheduleId: string): ScheduleRecord | null {
    return this.dependencies.schedulerService.showSchedule(scheduleId);
  }

  public listScheduleRuns(scheduleId: string, query?: ScheduleRunListQuery): ScheduleRunRecord[] {
    return this.dependencies.schedulerService.listScheduleRuns(scheduleId, query);
  }

  public pauseSchedule(scheduleId: string): ScheduleRecord {
    return this.dependencies.schedulerService.pauseSchedule(scheduleId);
  }

  public resumeSchedule(scheduleId: string): ScheduleRecord {
    return this.dependencies.schedulerService.resumeSchedule(scheduleId);
  }

  public runScheduleNow(scheduleId: string): ScheduleRunRecord {
    return this.dependencies.schedulerService.runNow(scheduleId);
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
    const liveStats = this.dependencies.provider.getStats?.() ?? null;
    if (liveStats !== null && liveStats.totalRequests > 0) {
      return liveStats;
    }

    const traceStats = buildProviderStatsFromTrace(
      this.dependencies.provider.name,
      this.dependencies.listTasks().flatMap((task) => this.dependencies.listTrace(task.taskId))
    );
    return traceStats.totalRequests > 0 ? traceStats : liveStats;
  }

  public traceTask(taskId: string): TraceEvent[] {
    return this.dependencies.listTrace(taskId);
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
    const latestThreadSnapshot = [...trace]
      .reverse()
      .find(
        (event): event is Extract<TraceEvent, { eventType: "thread_snapshot_created" }> =>
          event.eventType === "thread_snapshot_created"
      )?.payload ?? null;

    return {
      contextAssembly,
      latestThreadSnapshot,
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
    const artifact =
      artifactId === "last"
        ? this.dependencies.findLatestArtifactByType("file_rollback")
        : this.dependencies.findArtifact(artifactId);

    if (artifact === null) {
      throw new AppError({
        code: "tool_execution_error",
        message: `Rollback artifact ${artifactId} was not found.`
      });
    }

    if (artifact.artifactType !== "file_rollback" || !isRollbackContent(artifact.content)) {
      throw new AppError({
        code: "tool_validation_error",
        message: `Artifact ${artifact.artifactId} is not a file rollback checkpoint.`
      });
    }

    const targetPath = artifact.content.path;
    const originalExists = artifact.content.originalExists;
    if (originalExists) {
      const contentToRestore =
        typeof artifact.content.snapshotPath === "string"
          ? await fs.readFile(artifact.content.snapshotPath, "utf8")
          : artifact.content.originalContent;
      await fs.mkdir(dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, contentToRestore, "utf8");
    } else {
      await fs.rm(targetPath, { force: true });
    }

    this.dependencies.traceService.record({
      actor: "runtime.rollback",
      eventType: "file_rollback",
      payload: {
        artifactId: artifact.artifactId,
        operation: artifact.content.operation,
        originalExists,
        path: targetPath,
        restoredHash: artifact.content.sha256
      },
      stage: "tooling",
      summary: originalExists ? `Restored ${targetPath}` : `Removed ${targetPath}`,
      taskId: artifact.taskId
    });

    this.dependencies.auditService.record({
      action: "file_rollback",
      actor: "runtime.rollback",
      approvalId: null,
      outcome: "succeeded",
      payload: {
        artifactId: artifact.artifactId,
        operation: artifact.content.operation,
        originalExists,
        path: targetPath
      },
      summary: originalExists ? `Restored ${targetPath}` : `Removed ${targetPath}`,
      taskId: artifact.taskId,
      toolCallId: artifact.toolCallId
    });

    return {
      artifact,
      deleted: !originalExists,
      path: targetPath,
      restored: originalExists
    };
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
    const experiences = this.dependencies.listExperiences();
    const skills = this.dependencies.skillRegistry.listSkills();
    const configFiles = checkWorkspaceConfigFiles(this.dependencies.workspaceRoot);
    const databaseReachable = canOpenDatabase(this.dependencies.databasePath);
    const schemaVersion = readSchemaVersion(this.dependencies.databasePath);
    const distFresh = checkDistFreshness(this.dependencies.workspaceRoot);
    const corepackAvailable = isCommandAvailable("corepack");
    const pnpmVersion = resolveCommandVersion("pnpm");

    return {
      apiKeyConfigured: providerHealth.apiKeyConfigured,
      allowedFetchHosts: this.dependencies.allowedFetchHosts,
      configPath: this.dependencies.providerConfig.configPath,
      configSource: this.dependencies.providerConfig.configSource,
      databasePath: this.dependencies.databasePath,
      endpointReachable: providerHealth.endpointReachable,
      experienceStats: {
        accepted: experiences.filter((experience) => experience.status === "accepted").length,
        candidate: experiences.filter((experience) => experience.status === "candidate").length,
        promoted: experiences.filter((experience) => experience.status === "promoted").length,
        rejected: experiences.filter((experience) => experience.status === "rejected").length,
        stale: experiences.filter((experience) => experience.status === "stale").length,
        total: experiences.length
      },
      issues,
      maxRetries: this.dependencies.providerConfig.maxRetries,
      modelAvailable: providerHealth.modelAvailable,
      modelConfigured: providerHealth.modelConfigured,
      modelName: providerHealth.modelName,
      nodeVersion: process.version,
      pnpmVersion,
      corepackAvailable,
      providerHealthMessage: providerHealth.message,
      providerName: this.dependencies.provider.name,
      runtimeConfigPath: this.dependencies.runtimeConfigPath,
      runtimeConfigSource: this.dependencies.runtimeConfigSource,
      runtimeVersion: this.dependencies.runtimeVersion,
      configFiles,
      databaseReachable,
      distFresh,
      schemaVersion,
      shell: process.env.ComSpec,
      skillStats: {
        enabled: skills.skills.length,
        issues: skills.issues.length,
        total: skills.skills.length + skills.issues.length
      },
      tokenBudget: this.dependencies.tokenBudget,
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

interface RollbackArtifactContent extends JsonObject {
  createdAt: string;
  operation: string;
  originalContent: string;
  originalExists: true;
  path: string;
  snapshotPath?: string;
  sha256: string;
}

interface DeleteRollbackArtifactContent extends JsonObject {
  createdAt: string;
  operation: string;
  originalContent: null;
  originalExists: false;
  path: string;
  sha256: null;
}

function isRollbackContent(
  value: ArtifactRecord["content"]
): value is RollbackArtifactContent | DeleteRollbackArtifactContent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const content = value as Record<string, unknown>;
  if (typeof content.path !== "string" || typeof content.operation !== "string") {
    return false;
  }

  if (content.originalExists === true) {
    return typeof content.originalContent === "string" && typeof content.sha256 === "string";
  }

  return content.originalExists === false && content.originalContent === null;
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

  if (!isCommandAvailable("corepack")) {
    issues.push("corepack is not available.");
  }

  return issues;
}

function checkWorkspaceConfigFiles(
  workspaceRoot: string
): Array<{ exists: boolean; file: string; parseable: boolean }> {
  const files = [
    "provider.config.json",
    "runtime.config.json",
    "sandbox.config.json",
    "gateway.config.json",
    "feishu.config.json",
    "mcp.config.json",
    "mcp-server.config.json"
  ];

  return files.map((file) => {
    const path = join(workspaceRoot, ".auto-talon", file);
    if (!existsSync(path)) {
      return { exists: false, file, parseable: false };
    }
    try {
      const content = readFileSync(path, "utf8").trim();
      if (content.length > 0) {
        JSON.parse(content);
      }
      return { exists: true, file, parseable: true };
    } catch {
      return { exists: true, file, parseable: false };
    }
  });
}

function canOpenDatabase(databasePath: string): boolean {
  if (databasePath === ":memory:") {
    return true;
  }
  try {
    const db = new DatabaseSync(databasePath);
    db.close();
    return true;
  } catch {
    return false;
  }
}

function readSchemaVersion(databasePath: string): number | null {
  if (databasePath === ":memory:" || !existsSync(databasePath)) {
    return null;
  }
  try {
    const db = new DatabaseSync(databasePath);
    const row = db.prepare("PRAGMA user_version").get() as { user_version?: number };
    db.close();
    return row.user_version ?? 0;
  } catch {
    return null;
  }
}

function checkDistFreshness(workspaceRoot: string): boolean | null {
  const cliSource = join(workspaceRoot, "src", "cli", "index.ts");
  const cliDist = join(workspaceRoot, "dist", "cli", "index.js");
  if (!existsSync(cliSource) || !existsSync(cliDist)) {
    return null;
  }
  return statSync(cliDist).mtimeMs >= statSync(cliSource).mtimeMs;
}

function isCommandAvailable(command: string): boolean {
  return (
    spawnSync(command, ["--version"], {
      encoding: "utf8",
      shell: process.platform === "win32"
    }).status === 0
  );
}

function resolveCommandVersion(command: string): string | null {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32"
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim().split("\n")[0] ?? null;
}

function buildProviderStatsFromTrace(
  providerName: string,
  trace: TraceEvent[]
): ProviderStatsSnapshot {
  const providerEvents = trace.filter(
    (event) =>
      event.eventType === "provider_request_succeeded" ||
      event.eventType === "provider_request_failed"
  );
  const successes = providerEvents.filter((event) => event.eventType === "provider_request_succeeded");
  const failures = providerEvents.filter((event) => event.eventType === "provider_request_failed");
  const totalLatency = providerEvents.reduce((sum, event) => {
    if (event.eventType === "provider_request_succeeded" || event.eventType === "provider_request_failed") {
      return sum + event.payload.latencyMs;
    }
    return sum;
  }, 0);
  const retryCount = providerEvents.reduce((sum, event) => {
    if (event.eventType === "provider_request_succeeded" || event.eventType === "provider_request_failed") {
      return sum + event.payload.retryCount;
    }
    return sum;
  }, 0);
  const tokenUsage = successes.reduce<ProviderUsage>(
    (usage, event) => {
      if (event.eventType !== "provider_request_succeeded") {
        return usage;
      }
      const payload = event.payload.usage;
      const inputTokens = readNumber(payload?.inputTokens);
      const outputTokens = readNumber(payload?.outputTokens);
      const totalTokens = readNumber(payload?.totalTokens);
      const cachedInputTokens = readNumber(payload?.cachedInputTokens);
      return {
        cachedInputTokens: (usage.cachedInputTokens ?? 0) + (cachedInputTokens ?? 0),
        inputTokens: usage.inputTokens + (inputTokens ?? 0),
        outputTokens: usage.outputTokens + (outputTokens ?? 0),
        totalTokens:
          (usage.totalTokens ?? usage.inputTokens + usage.outputTokens) +
          (totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0))
      };
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    }
  );
  const lastRequestAt = providerEvents.at(-1)?.timestamp ?? null;
  const lastFailure = [...failures].reverse()[0];

  return {
    averageLatencyMs:
      providerEvents.length === 0 ? 0 : Number((totalLatency / providerEvents.length).toFixed(2)),
    failedRequests: failures.length,
    lastErrorCategory:
      lastFailure?.eventType === "provider_request_failed" ? lastFailure.payload.errorCategory : null,
    lastRequestAt,
    providerName,
    retryCount,
    successfulRequests: successes.length,
    tokenUsage,
    totalRequests: providerEvents.length
  };
}

function extractTimelineIteration(event: TraceEvent): number | null {
  const payload = event.payload as { iteration?: unknown };
  return typeof payload.iteration === "number" ? payload.iteration : null;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
