import type { AuditService } from "../audit/audit-service.js";
import type { TraceService } from "../tracing/trace-service.js";
import type { AgentApplicationService } from "../runtime/application-service.js";
import type {
  AdapterDescriptor,
  AdapterCapabilityName,
  GatewayRuntimeApi,
  GatewayInboxFilter,
  InboxDeliveryEvent,
  InboxItem,
  GatewayTaskEvent,
  GatewayTaskLaunchResult,
  GatewayTaskRequest,
  GatewayTaskSnapshot,
  GatewayTaskResultView,
  RuntimeRunOptions
} from "../types/index.js";

import { collectCapabilityNotices } from "./capability-policy.js";
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
  sessionMapper: GatewaySessionMapper;
  traceService: TraceService;
}

export class GatewayRuntimeFacade implements GatewayRuntimeApi {
  private readonly completionListeners = new Map<string, Set<(event: GatewayTaskEvent) => void>>();
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
    request: GatewayTaskRequest
  ): Promise<GatewayTaskLaunchResult> {
    if (this.dependencies.guard !== undefined) {
      const decision = await this.dependencies.guard.evaluate(adapter.adapterId, request);
      if (!decision.allowed) {
        this.recordGuardDecision(adapter.adapterId, request, decision.reason, decision.message);
        throw new Error(decision.message);
      }
    }

    const identityBinding = this.dependencies.identityMapper.bind(adapter.adapterId, request.requester);
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
    runOptions.userId = continuation?.runtimeUserId ?? identityBinding.runtimeUserId;
    runOptions.agentProfileId = request.agentProfileId ?? runOptions.agentProfileId;
    runOptions.metadata = {
      ...(request.metadata ?? {}),
      gateway: {
        adapterId: adapter.adapterId,
        adapterKind: adapter.kind,
        externalSessionId: request.requester.externalSessionId,
        externalUserId: request.requester.externalUserId,
        runtimeUserId: continuation?.runtimeUserId ?? identityBinding.runtimeUserId,
        lineage: {
          continuationMode: request.continuation ?? "resume-latest",
          previousTaskId: continuation?.previousTaskId ?? null
        }
      }
    };

    if (request.timeoutMs !== undefined) {
      runOptions.timeoutMs = request.timeoutMs;
    }

    const run = await this.dependencies.applicationService.runTask(runOptions);
    const sessionBinding = this.dependencies.sessionMapper.bindTask({
      adapterId: adapter.adapterId,
      externalSessionId: request.requester.externalSessionId,
      externalUserId: request.requester.externalUserId,
      metadata: request.metadata ?? {},
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
      result: toGatewayTaskResult(
        run.task.taskId,
        run.task.status,
        run.output,
        run.error,
        this.findPendingApprovalId(run.task.taskId)
      ),
      sessionBinding
    };
    this.emitCompletion(run.task.taskId, {
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
  }

  public async resolveApproval(params: {
    adapterId: string;
    approvalId: string;
    decision: "allow" | "deny";
    reviewerExternalUserId: string | null;
    reviewerRuntimeUserId: string;
  }): Promise<GatewayTaskLaunchResult | null> {
    const approvalResult = await this.dependencies.applicationService.resolveApproval(
      params.approvalId,
      params.decision,
      params.reviewerRuntimeUserId
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
      result: toGatewayTaskResult(
        approvalResult.task.taskId,
        approvalResult.task.status,
        approvalResult.output,
        approvalResult.error,
        this.findPendingApprovalId(approvalResult.task.taskId)
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
      task: {
        errorCode: details.task.errorCode,
        errorMessage: details.task.errorMessage,
        output: details.task.finalOutput,
        pendingApprovalId: this.findPendingApprovalId(details.task.taskId),
        status: details.task.status,
        taskId: details.task.taskId
      },
      trace: details.trace
    };
  }

  public listInbox(filter: GatewayInboxFilter = {}): InboxItem[] {
    return this.dependencies.applicationService.listInbox(filter);
  }

  public markInboxDone(
    inboxId: string,
    reviewerRuntimeUserId: string
  ): import("../types/index.js").InboxItem {
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
    return this.dependencies.applicationService.subscribeInbox(filter, (event) => {
      listener(event);
      for (const outbound of this.outboundAdapters.values()) {
        void outbound.sendInboxEvent?.(event);
      }
    });
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

    return () => {
      unsubscribeTrace();
      unsubscribeAudit();
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

  private findPendingApprovalId(taskId: string): string | null {
    return (
      this.dependencies.applicationService
        .showTask(taskId)
        .approvals.find((approval) => approval.status === "pending")?.approvalId ?? null
    );
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
