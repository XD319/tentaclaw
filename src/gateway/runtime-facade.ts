import { randomUUID } from "node:crypto";

import type { AuditService } from "../audit/audit-service.js";
import { buildApprovalPromptContext } from "../approvals/approval-prompt-view-model.js";
import { isHttpAuthDisabled, resolveHttpAuthToken } from "../core/http-auth.js";
import type { TraceService } from "../tracing/trace-service.js";
import type { AgentApplicationService } from "../runtime/application-service.js";
import { parseExecutionModeInput } from "../schedule/execution-mode.js";
import { resolveDefaultDeliveryTargets } from "../schedule/schedule-delivery.js";
import type { ScheduleExecutionMode } from "../schedule/execution-mode.js";
import type {
  AdapterDescriptor,
  AdapterCapabilityName,
  ApprovalRecord,
  GatewayRuntimeApi,
  GatewayInboxFilter,
  InboxDeliveryEvent,
  InboxItem,
  GatewayTaskEvent,
  GatewayTaskLaunchResult,
  GatewayTaskRequest,
  GatewayTaskStreamObserver,
  GatewayTaskSnapshot,
  GatewayTaskResultView,
  JsonObject,
  RuntimeRunOptions,
  ScheduleListQuery,
  ScheduleRecord,
  ScheduleRunListQuery,
  ScheduleRunRecord,
  ScheduleStatusSummary
} from "../types/index.js";

import { collectCapabilityNotices } from "./capability-policy.js";
import { tryHandleGatewayResumeCommand } from "./session-commands.js";
import type { GatewayGuard } from "./gateway-guard.js";
import type { GatewayIdentityMapper } from "./identity-mapper.js";
import type { GatewaySessionMapper } from "./session-mapper.js";

export interface GatewayRuntimeFacadeDependencies {
  applicationService: AgentApplicationService;
  auditService: AuditService;
  createRunOptions: (taskInput: string, cwd: string) => RuntimeRunOptions;
  defaultCwd: string;
  guard?: GatewayGuard;
  identityMapper: GatewayIdentityMapper;
  providerName: string;
  sessionMapper: GatewaySessionMapper;
  traceService: TraceService;
}

export class GatewayRuntimeFacade implements GatewayRuntimeApi {
  private readonly completionListeners = new Map<string, Set<(event: GatewayTaskEvent) => void>>();
  private inboxOutboundUnsubscribe: (() => void) | null = null;
  private readonly outboundAdapters = new Map<
    string,
    {
      sendCapabilityNotice?: (taskId: string, notice: {
        capability: AdapterCapabilityName;
        fallbackBehavior: string;
        message: string;
        severity: "info" | "warning";
      }) => Promise<void>;
      sendInboxEvent?: (event: InboxDeliveryEvent) => Promise<void>;
      sendEvent?: (event: GatewayTaskEvent) => Promise<void>;
      sendResult?: (result: GatewayTaskLaunchResult) => Promise<void>;
    }
  >();

  public constructor(private readonly dependencies: GatewayRuntimeFacadeDependencies) {}

  public async submitTask(
    adapter: AdapterDescriptor,
    request: GatewayTaskRequest,
    observer?: GatewayTaskStreamObserver
  ): Promise<GatewayTaskLaunchResult> {
    const authorizedRequest = this.withLocalGatewayAuth(request);
    if (this.dependencies.guard !== undefined) {
      const decision = await this.dependencies.guard.evaluate(adapter.adapterId, authorizedRequest);
      if (!decision.allowed) {
        this.recordGuardDecision(adapter.adapterId, request, decision.reason, decision.message);
        throw new Error(decision.message);
      }
    }

    const ownerUserId = request.requester.externalUserId ?? process.env.USERNAME ?? process.env.USER ?? "local-user";
    const identityBinding = this.dependencies.identityMapper.bind(adapter.adapterId, request.requester);
    const resumeCommand = tryHandleGatewayResumeCommand({
      adapterId: adapter.adapterId,
      externalSessionId: request.requester.externalSessionId,
      externalUserId: request.requester.externalUserId,
      ownerUserId,
      runtimeUserId: identityBinding.runtimeUserId,
      sessions: this.dependencies.applicationService,
      taskInput: request.taskInput,
      cwd: this.dependencies.defaultCwd
    });
    if (resumeCommand.handled) {
      const taskId = randomUUID();
      const sessionBinding = this.dependencies.sessionMapper.bindTask({
        adapterId: adapter.adapterId,
        externalSessionId: request.requester.externalSessionId,
        externalUserId: request.requester.externalUserId,
        metadata: request.metadata ?? {},
        runtimeSessionId: this.dependencies.applicationService.resolveGatewayRuntimeSessionId(
          adapter.adapterId,
          request.requester.externalSessionId
        ),
        runtimeUserId: identityBinding.runtimeUserId,
        taskId
      });
      return {
        adapter,
        notices: [],
        result: toGatewayTaskResult(taskId, "succeeded", resumeCommand.message, undefined, null),
        sessionBinding
      };
    }

    const continuation =
      request.continuation === "new"
        ? null
        : this.dependencies.sessionMapper.resolveContinuation({
            adapterId: adapter.adapterId,
            externalSessionId: request.requester.externalSessionId
          });
    const runOptions = this.dependencies.createRunOptions(
      request.taskInput,
      request.cwd ?? this.dependencies.defaultCwd
    );
    runOptions.taskId ??= randomUUID();
    runOptions.userId = continuation?.runtimeUserId ?? identityBinding.runtimeUserId;
    runOptions.agentProfileId = request.agentProfileId ?? runOptions.agentProfileId;
    runOptions.metadata = {
      ...(request.metadata ?? {}),
      source: "gateway",
      sourceDetail: `${adapter.adapterId}:${request.requester.externalSessionId}`,
      gateway: {
        adapterId: adapter.adapterId,
        adapterKind: adapter.kind,
        externalSessionId: request.requester.externalSessionId,
        externalUserId: request.requester.externalUserId,
        runtimeUserId: continuation?.runtimeUserId ?? identityBinding.runtimeUserId,
        lineage: {
          continuationMode: request.continuation ?? "resume-latest",
          previousTaskId: continuation?.previousTaskId ?? null,
          runtimeSessionId: continuation?.runtimeSessionId ?? null
        }
      }
    };

    if (request.timeoutMs !== undefined) {
      runOptions.timeoutMs = request.timeoutMs;
    }
    if (observer?.signal !== undefined && runOptions.signal === undefined) {
      runOptions.signal = observer.signal;
    }
    if (observer !== undefined) {
      const priorOutputEvent = runOptions.onOutputEvent;
      runOptions.onOutputEvent = (event) => {
        priorOutputEvent?.(event);
        observer.onEvent({
          kind: "output",
          output: event,
          taskId: event.taskId
        });
      };
      observer.onEvent({
        kind: "progress",
        detail: "Task accepted",
        taskId: runOptions.taskId
      });
    }

    const run =
      continuation?.runtimeSessionId !== null &&
      continuation?.runtimeSessionId !== undefined &&
      request.continuation !== "new"
        ? await this.dependencies.applicationService.continueSession(
            continuation.runtimeSessionId,
            request.taskInput,
            runOptions
          )
        : await this.dependencies.applicationService.runTask({
            ...runOptions,
            ...(continuation?.runtimeSessionId !== null && continuation?.runtimeSessionId !== undefined
              ? { sessionId: continuation.runtimeSessionId }
              : {})
          });
    const sessionBinding = this.dependencies.sessionMapper.bindTask({
      adapterId: adapter.adapterId,
      externalSessionId: request.requester.externalSessionId,
      externalUserId: request.requester.externalUserId,
      metadata: request.metadata ?? {},
      runtimeSessionId: run.task.sessionId ?? continuation?.runtimeSessionId ?? null,
      runtimeUserId: continuation?.runtimeUserId ?? identityBinding.runtimeUserId,
      taskId: run.task.taskId
    });

    this.dependencies.traceService.record({
      actor: `gateway.${adapter.adapterId}`,
      eventType: "gateway_request_received",
      payload: {
        adapterId: adapter.adapterId,
        adapterKind: adapter.kind,
        externalSessionId: request.requester.externalSessionId,
        externalUserId: request.requester.externalUserId,
        runtimeUserId: continuation?.runtimeUserId ?? identityBinding.runtimeUserId,
        previousTaskId: continuation?.previousTaskId ?? null
      },
      stage: "gateway",
      summary: `Gateway request accepted from ${adapter.adapterId}`,
      taskId: run.task.taskId
    });

    this.dependencies.auditService.record({
      action: "gateway_request",
      actor: `gateway.${adapter.adapterId}`,
      outcome: "attempted",
      payload: {
        adapterId: adapter.adapterId,
        adapterKind: adapter.kind,
        externalSessionId: request.requester.externalSessionId,
        externalUserId: request.requester.externalUserId,
        runtimeUserId: continuation?.runtimeUserId ?? identityBinding.runtimeUserId,
        previousTaskId: continuation?.previousTaskId ?? null
      },
      summary: `Gateway request entered from ${adapter.adapterId}`,
      taskId: run.task.taskId,
      toolCallId: null,
      approvalId: null
    });

    const notices = collectCapabilityNotices(
      adapter.adapterId,
      adapter.capabilities,
      request,
      run.task
    );

    for (const notice of notices) {
      this.dependencies.traceService.record({
        actor: `gateway.${adapter.adapterId}`,
        eventType: "gateway_capability_degraded",
        payload: {
          adapterId: adapter.adapterId,
          capability: notice.capability,
          fallbackBehavior: notice.fallbackBehavior,
          message: notice.message
        },
        stage: "gateway",
        summary: `Gateway fallback applied for ${notice.capability}`,
        taskId: run.task.taskId
      });

      this.dependencies.auditService.record({
        action: "gateway_capability_degraded",
        actor: `gateway.${adapter.adapterId}`,
        outcome: "attempted",
        payload: {
          adapterId: adapter.adapterId,
          capability: notice.capability,
          fallbackBehavior: notice.fallbackBehavior,
          message: notice.message,
          severity: notice.severity
        },
        summary: `Gateway fallback applied for ${notice.capability}`,
        taskId: run.task.taskId,
        toolCallId: null,
        approvalId: null
      });
    }

    const launchResult = {
      adapter,
      notices,
      result: this.buildGatewayTaskResult(
        run.task.taskId,
        run.task.status,
        run.output,
        run.error
      ),
      sessionBinding
    };
    this.emitCompletion(run.task.taskId, {
      kind: "progress",
      detail: `Task moved to ${run.task.status}`,
      taskId: run.task.taskId
    });
    observer?.onEvent({
      kind: "progress",
      detail: `Task moved to ${run.task.status}`,
      taskId: run.task.taskId
    });
    void this.outboundAdapters.get(adapter.adapterId)?.sendResult?.(launchResult);
    for (const notice of notices) {
      void this.outboundAdapters.get(adapter.adapterId)?.sendCapabilityNotice?.(
        run.task.taskId,
        notice
      );
    }
    return launchResult;
  }

  public registerOutboundAdapter(
    adapterId: string,
    adapter: {
      sendCapabilityNotice?: (taskId: string, notice: {
        capability: AdapterCapabilityName;
        fallbackBehavior: string;
        message: string;
        severity: "info" | "warning";
      }) => Promise<void>;
      sendInboxEvent?: (event: InboxDeliveryEvent) => Promise<void>;
      sendEvent?: (event: GatewayTaskEvent) => Promise<void>;
      sendResult?: (result: GatewayTaskLaunchResult) => Promise<void>;
    }
  ): void {
    this.outboundAdapters.set(adapterId, adapter);
    if (typeof adapter.sendInboxEvent === "function") {
      this.ensureInboxOutboundSubscription();
    }
  }

  public createSchedule(
    adapter: AdapterDescriptor,
    request: {
      agentProfileId?: "executor" | "planner" | "reviewer";
      cron?: string | null;
      cwd?: string;
      every?: string | null;
      input: string;
      messageId?: string | null;
      metadata?: JsonObject;
      name: string;
      requester: {
        externalSessionId: string;
        externalUserId: string | null;
        externalUserLabel: string | null;
      };
      runAt?: string | null;
      sessionId?: string | null;
      timezone?: string | null;
      deliveryTargets?: Array<"inbox" | "origin" | "silent" | "webhook">;
      executionMode?: ScheduleExecutionMode | `session:${string}`;
    }
  ): ScheduleRecord {
    const identityBinding = this.dependencies.identityMapper.bind(adapter.adapterId, request.requester);
    const continuation = this.dependencies.sessionMapper.resolveContinuation({
      adapterId: adapter.adapterId,
      externalSessionId: request.requester.externalSessionId
    });
    const ownerUserId = continuation?.runtimeUserId ?? identityBinding.runtimeUserId;
    const cwd = request.cwd ?? this.dependencies.defaultCwd;
    const runOptions = this.dependencies.createRunOptions(request.input, cwd);
    const sessionId =
      request.sessionId === undefined
        ? continuation === null
          ? null
          : this.dependencies.applicationService.showTask(continuation.previousTaskId).task?.sessionId ?? null
        : request.sessionId;
    const metadata: JsonObject = {
      ...(request.metadata ?? {}),
      gateway: {
        adapterId: adapter.adapterId,
        adapterKind: adapter.kind,
        externalSessionId: request.requester.externalSessionId,
        externalUserId: request.requester.externalUserId,
        runtimeUserId: ownerUserId
      },
      origin: {
        adapter: adapter.adapterId,
        chatId: request.requester.externalSessionId,
        messageId: request.messageId ?? null,
        sessionId: request.requester.externalSessionId,
        userId: request.requester.externalUserId
      }
    };

    const parsedExecutionMode =
      request.executionMode === undefined
        ? { executionMode: sessionId !== null ? ("continue" as const) : ("isolated" as const) }
        : parseExecutionModeInput(
            typeof request.executionMode === "string" && request.executionMode.startsWith("session:")
              ? request.executionMode
              : request.executionMode
          );
    const schedule = this.dependencies.applicationService.createSchedule({
      agentProfileId: request.agentProfileId ?? runOptions.agentProfileId,
      cwd,
      deliveryTargets: request.deliveryTargets ?? resolveDefaultDeliveryTargets(metadata),
      executionMode: parsedExecutionMode.executionMode,
      input: request.input,
      metadata,
      name: request.name,
      ownerUserId,
      providerName: this.dependencies.providerName,
      ...(request.cron !== undefined ? { cron: request.cron } : {}),
      ...(request.every !== undefined ? { every: request.every } : {}),
      ...(request.runAt !== undefined ? { runAt: request.runAt } : {}),
      ...(parsedExecutionMode.sessionId !== undefined
        ? { sessionId: parsedExecutionMode.sessionId }
        : sessionId !== null
          ? { sessionId }
          : {}),
      ...(request.timezone !== undefined ? { timezone: request.timezone } : {})
    });

    this.dependencies.traceService.record({
      actor: `gateway.${adapter.adapterId}`,
      eventType: "schedule_created",
      payload: {
        adapterId: adapter.adapterId,
        externalSessionId: request.requester.externalSessionId,
        nextFireAt: schedule.nextFireAt,
        scheduleId: schedule.scheduleId,
        status: schedule.status === "paused" ? "paused" : "active"
      },
      stage: "gateway",
      summary: `Gateway schedule created from ${adapter.adapterId}`,
      taskId: `schedule:${schedule.scheduleId}`
    });

    this.dependencies.auditService.record({
      action: "gateway_schedule_created",
      actor: `gateway.${adapter.adapterId}`,
      approvalId: null,
      outcome: "succeeded",
      payload: {
        adapterId: adapter.adapterId,
        externalSessionId: request.requester.externalSessionId,
        scheduleId: schedule.scheduleId
      },
      summary: `Gateway schedule created from ${adapter.adapterId}`,
      taskId: null,
      toolCallId: null
    });

    return schedule;
  }

  public listSchedules(query?: ScheduleListQuery): ScheduleRecord[] {
    return this.dependencies.applicationService.listSchedules(query);
  }

  public showSchedule(scheduleId: string): ScheduleRecord | null {
    return this.dependencies.applicationService.showSchedule(scheduleId);
  }

  public listScheduleRuns(scheduleId: string, query?: ScheduleRunListQuery): ScheduleRunRecord[] {
    return this.dependencies.applicationService.listScheduleRuns(scheduleId, query);
  }

  public pauseSchedule(scheduleId: string): ScheduleRecord {
    return this.dependencies.applicationService.pauseSchedule(scheduleId);
  }

  public archiveSchedule(scheduleId: string): ScheduleRecord {
    return this.dependencies.applicationService.archiveSchedule(scheduleId);
  }

  public resumeSchedule(scheduleId: string): ScheduleRecord {
    return this.dependencies.applicationService.resumeSchedule(scheduleId);
  }

  public runScheduleNow(scheduleId: string): ScheduleRunRecord {
    return this.dependencies.applicationService.runScheduleNow(scheduleId);
  }

  public scheduleStatus(): ScheduleStatusSummary {
    return this.dependencies.applicationService.scheduleStatus();
  }

  public updateSchedule(
    scheduleId: string,
    request: Parameters<typeof this.dependencies.applicationService.updateSchedule>[1]
  ): ScheduleRecord {
    return this.dependencies.applicationService.updateSchedule(scheduleId, request);
  }

  public async resolveApproval(params: {
    adapterId: string;
    allowScope?: "once" | "session" | "always";
    approvalId: string;
    decision: "allow" | "deny";
    reviewerExternalUserId: string | null;
    reviewerRuntimeUserId: string;
  }): Promise<GatewayTaskLaunchResult | null> {
    const approvalResult = await this.dependencies.applicationService.resolveApproval(
      params.approvalId,
      params.decision,
      params.reviewerRuntimeUserId,
      params.decision === "allow" ? params.allowScope : undefined
    );

    this.dependencies.traceService.record({
      actor: `gateway.${params.adapterId}`,
      eventType: "gateway_approval_resolved",
      payload: {
        adapterId: params.adapterId,
        approvalId: params.approvalId,
        decision: params.decision,
        reviewerExternalUserId: params.reviewerExternalUserId,
        reviewerRuntimeUserId: params.reviewerRuntimeUserId
      },
      stage: "gateway",
      summary: `Gateway approval resolved by ${params.adapterId}`,
      taskId: approvalResult.task.taskId
    });
    this.dependencies.auditService.record({
      action: "gateway_approval_resolved",
      actor: `gateway.${params.adapterId}`,
      approvalId: params.approvalId,
      outcome: "attempted",
      payload: {
        adapterId: params.adapterId,
        decision: params.decision,
        reviewerExternalUserId: params.reviewerExternalUserId,
        reviewerRuntimeUserId: params.reviewerRuntimeUserId
      },
      summary: `Gateway approval resolved by ${params.adapterId}`,
      taskId: approvalResult.task.taskId,
      toolCallId: approvalResult.approval.toolCallId
    });

    const sessionBinding = this.dependencies.sessionMapper.findByTaskId(approvalResult.task.taskId);
    if (sessionBinding === null) {
      return null;
    }

    const launchResult: GatewayTaskLaunchResult = {
      adapter: {
        adapterId: params.adapterId,
        contractVersion: 1,
        capabilities: {
          approvalInteraction: { supported: true },
          attachmentCapability: { supported: true },
          fileCapability: { supported: true },
          streamingCapability: { supported: true },
          structuredCardCapability: { supported: true },
          textInteraction: { supported: true }
        },
        description: "Gateway approval resolver",
        displayName: "Gateway Approval Resolver",
        kind: "sdk",
        lifecycleState: "running"
      },
      notices: [],
      result: this.buildGatewayTaskResult(
        approvalResult.task.taskId,
        approvalResult.task.status,
        approvalResult.output,
        approvalResult.error
      ),
      sessionBinding
    };
    this.emitCompletion(approvalResult.task.taskId, {
      kind: "progress",
      detail: `Task moved to ${approvalResult.task.status}`,
      taskId: approvalResult.task.taskId
    });
    return launchResult;
  }

  public getTaskSnapshot(taskId: string): GatewayTaskSnapshot | null {
    const details = this.dependencies.applicationService.showTask(taskId);
    if (details.task === null) {
      return null;
    }

    const auditEntries = this.dependencies.applicationService.auditTask(taskId);
    const sessionBinding = this.dependencies.sessionMapper.findByTaskId(taskId);
    const notices = auditEntries
      .filter((entry) => entry.action === "gateway_capability_degraded")
      .map((entry) => ({
        capability: readString(entry.payload.capability) as AdapterCapabilityName,
        fallbackBehavior: readString(entry.payload.fallbackBehavior),
        message: readString(entry.payload.message),
        severity:
          entry.payload.severity === "warning" ? ("warning" as const) : ("info" as const)
      }));

    return {
      adapterSource:
        sessionBinding === null
          ? null
          : {
              adapterId: sessionBinding.adapterId,
              externalSessionId: sessionBinding.externalSessionId,
              externalUserId: sessionBinding.externalUserId,
              runtimeUserId: sessionBinding.runtimeUserId
            },
      audit: auditEntries,
      notices,
      output: details.output,
      task: this.buildGatewayTaskResult(
        details.task.taskId,
        details.task.status,
        details.task.finalOutput,
        details.task.errorCode === null || details.task.errorMessage === null
          ? undefined
          : {
              code: details.task.errorCode,
              message: details.task.errorMessage
            }
      ),
      trace: details.trace
    };
  }

  public listInbox(filter: GatewayInboxFilter = {}): InboxItem[] {
    return this.dependencies.applicationService.listInbox(filter);
  }

  public listTaskPendingApprovals(taskId: string): ApprovalRecord[] {
    return this.dependencies.applicationService
      .listPendingApprovals()
      .filter((approval) => approval.taskId === taskId);
  }

  public markInboxDone(
    inboxId: string,
    reviewerRuntimeUserId: string
  ): InboxItem {
    const item = this.dependencies.applicationService.markInboxDone(inboxId, reviewerRuntimeUserId);
    this.dependencies.traceService.record({
      actor: "gateway.runtime-facade",
      eventType: "gateway_approval_resolved",
      payload: {
        adapterId: "gateway",
        approvalId: item.approvalId ?? inboxId,
        decision: "allow",
        reviewerExternalUserId: null,
        reviewerRuntimeUserId
      },
      stage: "gateway",
      summary: `Gateway marked inbox item done: ${inboxId}`,
      taskId: item.taskId ?? "gateway-inbox"
    });
    return item;
  }

  public subscribeToInbox(
    filter: GatewayInboxFilter,
    listener: (event: InboxDeliveryEvent) => void
  ): () => void {
    return this.dependencies.applicationService.subscribeInbox(filter, listener);
  }

  public subscribeToTaskEvents(taskId: string, listener: (event: GatewayTaskEvent) => void): () => void {
    const unsubscribeTrace = this.dependencies.traceService.subscribe((trace) => {
      if (trace.taskId !== taskId) {
        return;
      }

      listener({
        kind: "trace",
        taskId,
        trace
      });
      for (const outbound of this.outboundAdapters.values()) {
        void outbound.sendEvent?.({
          kind: "trace",
          taskId,
          trace
        });
      }
    });

    const unsubscribeAudit = this.dependencies.auditService.subscribe((audit) => {
      if (audit.taskId !== taskId) {
        return;
      }

      listener({
        kind: "audit",
        audit,
        taskId
      });
      for (const outbound of this.outboundAdapters.values()) {
        void outbound.sendEvent?.({
          kind: "audit",
          audit,
          taskId
        });
      }
    });
    const unsubscribeOutput = this.dependencies.applicationService.subscribeToTaskOutput(taskId, (output) => {
      listener({
        kind: "output",
        output,
        taskId
      });
      for (const outbound of this.outboundAdapters.values()) {
        void outbound.sendEvent?.({
          kind: "output",
          output,
          taskId
        });
      }
    });

    return () => {
      unsubscribeTrace();
      unsubscribeAudit();
      unsubscribeOutput();
    };
  }

  public subscribeToCompletion(taskId: string, listener: (event: GatewayTaskEvent) => void): () => void {
    const listeners = this.completionListeners.get(taskId) ?? new Set<(event: GatewayTaskEvent) => void>();
    listeners.add(listener);
    this.completionListeners.set(taskId, listeners);

    return () => {
      const current = this.completionListeners.get(taskId);
      if (current === undefined) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        this.completionListeners.delete(taskId);
      }
    };
  }

  private emitCompletion(taskId: string, event: GatewayTaskEvent): void {
    const listeners = this.completionListeners.get(taskId);
    if (listeners === undefined) {
      return;
    }
    for (const listener of listeners) {
      listener(event);
    }
  }

  private ensureInboxOutboundSubscription(): void {
    if (this.inboxOutboundUnsubscribe !== null) {
      return;
    }
    this.inboxOutboundUnsubscribe = this.dependencies.applicationService.subscribeInbox({}, (event) => {
      for (const outbound of this.outboundAdapters.values()) {
        void outbound.sendInboxEvent?.(event);
      }
    });
  }

  private findPendingApprovalId(taskId: string): string | null {
    return (
      this.dependencies.applicationService
        .showTask(taskId)
        .approvals.find((approval) => approval.status === "pending")?.approvalId ?? null
    );
  }

  private buildGatewayTaskResult(
    taskId: string,
    status: string,
    output: string | null,
    error:
      | {
          code: string;
          message: string;
        }
      | undefined
  ): GatewayTaskResultView {
    const pendingApprovalId = this.findPendingApprovalId(taskId);
    const pendingApprovalContext =
      pendingApprovalId === null
        ? undefined
        : this.buildPendingApprovalContext(taskId, pendingApprovalId);

    const result: GatewayTaskResultView = {
      errorCode: error?.code ?? null,
      errorMessage: error?.message ?? null,
      output,
      pendingApprovalId,
      status,
      taskId
    };
    if (pendingApprovalContext !== undefined) {
      result.pendingApprovalContext = pendingApprovalContext;
    }
    return result;
  }

  private buildPendingApprovalContext(
    taskId: string,
    approvalId: string
  ): GatewayTaskResultView["pendingApprovalContext"] | undefined {
    const details = this.dependencies.applicationService.showTask(taskId);
    const approval = details.approvals.find((entry) => entry.approvalId === approvalId) ?? null;
    if (approval === null) {
      return undefined;
    }
    const toolCall =
      details.toolCalls.find((entry) => entry.toolCallId === approval.toolCallId) ?? null;
    const context = buildApprovalPromptContext(approval, toolCall);
    return {
      detailLines: context.detailLines,
      riskLevel: context.riskLevel,
      summaryLine: context.summaryLine,
      toolName: context.toolName
    };
  }

  private recordGuardDecision(
    adapterId: string,
    request: GatewayTaskRequest,
    reason: "rate_limited" | "denied" | "auth_failed",
    message: string
  ): void {
    const eventType =
      reason === "rate_limited"
        ? "gateway_rate_limited"
        : reason === "auth_failed"
          ? "gateway_auth_failed"
          : "gateway_denied";
    const action =
      reason === "rate_limited"
        ? "gateway_rate_limited"
        : reason === "auth_failed"
          ? "gateway_auth_failed"
          : "gateway_denied";

    this.dependencies.traceService.record({
      actor: `gateway.${adapterId}`,
      eventType,
      payload: {
        adapterId,
        externalSessionId: request.requester.externalSessionId,
        externalUserId: request.requester.externalUserId,
        message
      },
      stage: "gateway",
      summary: message,
      taskId: "gateway-guard"
    });
    this.dependencies.auditService.record({
      action,
      actor: `gateway.${adapterId}`,
      outcome: "denied",
      payload: {
        adapterId,
        externalSessionId: request.requester.externalSessionId,
        externalUserId: request.requester.externalUserId,
        message
      },
      summary: message,
      taskId: null,
      toolCallId: null,
      approvalId: null
    });
  }

  private withLocalGatewayAuth(request: GatewayTaskRequest): GatewayTaskRequest {
    if (isHttpAuthDisabled()) {
      return request;
    }
    const token = resolveHttpAuthToken(this.dependencies.defaultCwd);
    if (token === null) {
      return request;
    }
    const metadata = request.metadata ?? {};
    if (typeof metadata.authorization === "string" || typeof metadata.authToken === "string") {
      return request;
    }
    return {
      ...request,
      metadata: {
        ...metadata,
        authToken: token
      }
    };
  }
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toGatewayTaskResult(
  taskId: string,
  status: string,
  output: string | null,
  error:
    | {
        code: string;
        message: string;
      }
    | undefined,
  pendingApprovalId: string | null
): GatewayTaskResultView {
  return {
    errorCode: error?.code ?? null,
    errorMessage: error?.message ?? null,
    output,
    pendingApprovalId,
    status,
    taskId
  };
}
