import type { AuditService } from "../../audit/audit-service.js";
import type { BudgetService } from "../../runtime/budget/budget-service.js";
import type { TraceService } from "../../tracing/trace-service.js";
import type { Provider, ProviderTier, RouteKind, RoutingMode } from "../../types/index.js";

import { tierFor } from "./provider-tiers.js";

export interface ProviderRouterConfig {
  mode: RoutingMode;
  providers: {
    cheap?: string | undefined;
    balanced?: string | undefined;
    quality?: string | undefined;
  };
  helpers: {
    summarize?: ProviderTier | null;
    classify?: ProviderTier | null;
    recallRank?: ProviderTier | null;
  };
}

export interface SelectProviderInput {
  kind: RouteKind;
  taskId: string;
  threadId: string | null;
  mode?: RoutingMode;
}

export interface SelectProviderResult {
  provider: Provider | null;
  providerName: string | null;
  tier: ProviderTier | null;
  modeApplied: RoutingMode;
  reason: string;
}

export class ProviderRouter {
  private readonly providers = new Map<string, Provider>();
  private mode: RoutingMode;

  public constructor(
    private readonly config: ProviderRouterConfig,
    private readonly providerFactory: (name: string) => Provider,
    private readonly budgetService: BudgetService,
    private readonly traceService: TraceService,
    private readonly auditService: AuditService
  ) {
    this.mode = config.mode;
  }

  public getMode(): RoutingMode {
    return this.mode;
  }

  public setMode(mode: RoutingMode): void {
    this.mode = mode;
  }

  public selectProvider(input: SelectProviderInput): SelectProviderResult {
    const modeApplied = input.mode ?? this.mode;
    const softDowngrade =
      this.budgetService.isDowngradeActive("task", input.taskId) ||
      (input.threadId !== null && this.budgetService.isDowngradeActive("thread", input.threadId));
    const tier = this.resolveTier(input.kind, modeApplied, softDowngrade);
    const providerName = tier === null ? null : this.resolveProviderName(tier);
    const provider = providerName === null ? null : this.getOrCreateProvider(providerName);
    const reason =
      input.kind === "main"
        ? softDowngrade
          ? "soft budget downgrade"
          : `routing mode ${modeApplied}`
        : `helper route ${input.kind}`;

    this.traceService.record({
      actor: "runtime.router",
      eventType: "route_decision",
      payload: {
        kind: input.kind,
        mode: modeApplied,
        providerName,
        reason,
        taskId: input.taskId,
        threadId: input.threadId,
        tier
      },
      stage: "planning",
      summary: `Route ${input.kind} to ${providerName ?? "none"}`,
      taskId: input.taskId
    });
    this.auditService.record({
      action: "route_decided",
      actor: "runtime.router",
      approvalId: null,
      outcome: "succeeded",
      payload: {
        kind: input.kind,
        mode: modeApplied,
        providerName,
        reason,
        taskId: input.taskId,
        threadId: input.threadId,
        tier
      },
      summary: `Route decision for ${input.kind}`,
      taskId: input.taskId,
      toolCallId: null
    });

    return { modeApplied, provider, providerName, reason, tier };
  }

  private resolveTier(kind: RouteKind, mode: RoutingMode, downgrade: boolean): ProviderTier | null {
    if (kind === "main") {
      return downgrade ? "cheap" : tierFor(mode);
    }
    if (kind === "summarize") {
      return this.config.helpers.summarize ?? "cheap";
    }
    if (kind === "classify") {
      return this.config.helpers.classify ?? null;
    }
    return this.config.helpers.recallRank ?? null;
  }

  private resolveProviderName(tier: ProviderTier): string | null {
    if (tier === "cheap") {
      return this.config.providers.cheap ?? this.config.providers.balanced ?? null;
    }
    if (tier === "quality") {
      return this.config.providers.quality ?? this.config.providers.balanced ?? null;
    }
    return (
      this.config.providers.balanced ??
      this.config.providers.quality ??
      this.config.providers.cheap ??
      null
    );
  }

  private getOrCreateProvider(name: string): Provider {
    const existing = this.providers.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const provider = this.providerFactory(name);
    this.providers.set(name, provider);
    return provider;
  }
}
