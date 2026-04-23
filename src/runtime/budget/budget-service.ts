import type { AuditService } from "../../audit/audit-service.js";
import type { TraceService } from "../../tracing/trace-service.js";
import type {
  BudgetEnforcementDecision,
  BudgetLimits,
  BudgetScope,
  BudgetState,
  ProviderUsage,
  RoutingMode
} from "../../types/index.js";

import { classifyBudgetState } from "./budget-policy.js";

export interface BudgetServiceConfig {
  task: BudgetLimits;
  thread: BudgetLimits;
}

export interface RecordBudgetUsageInput {
  taskId: string;
  threadId: string | null;
  mode: RoutingMode;
  usage: ProviderUsage;
  costUsd: number | null;
}

export class BudgetService {
  private readonly taskStates = new Map<string, BudgetState>();
  private readonly threadStates = new Map<string, BudgetState>();
  private readonly taskDowngrade = new Set<string>();
  private readonly threadDowngrade = new Set<string>();

  public constructor(
    private readonly config: BudgetServiceConfig,
    private readonly traceService: TraceService,
    private readonly auditService: AuditService
  ) {}

  public start(): void {}

  public stop(): void {}

  public recordUsage(input: RecordBudgetUsageInput): BudgetEnforcementDecision {
    const taskState = nextState(this.taskStates.get(input.taskId), input.usage, input.costUsd);
    this.taskStates.set(input.taskId, taskState);
    const taskDecision = classifyBudgetState(taskState, this.config.task);
    this.handleDecision("task", input.taskId, input, taskState, taskDecision);
    if (taskDecision.action === "hard_abort") {
      return taskDecision;
    }

    if (input.threadId !== null) {
      const threadState = nextState(this.threadStates.get(input.threadId), input.usage, input.costUsd);
      this.threadStates.set(input.threadId, threadState);
      const threadDecision = classifyBudgetState(threadState, this.config.thread);
      this.handleDecision("thread", input.threadId, input, threadState, threadDecision);
      if (threadDecision.action === "hard_abort") {
        return threadDecision;
      }
      if (threadDecision.action === "soft_downgrade") {
        return threadDecision;
      }
    }

    return taskDecision;
  }

  public getTaskState(taskId: string): BudgetState | null {
    return this.taskStates.get(taskId) ?? null;
  }

  public getThreadState(threadId: string): BudgetState | null {
    return this.threadStates.get(threadId) ?? null;
  }

  public isDowngradeActive(scope: BudgetScope, id: string): boolean {
    return scope === "task" ? this.taskDowngrade.has(id) : this.threadDowngrade.has(id);
  }

  private handleDecision(
    scope: BudgetScope,
    id: string,
    input: RecordBudgetUsageInput,
    state: BudgetState,
    decision: BudgetEnforcementDecision
  ): void {
    if (decision.action === "continue") {
      return;
    }
    if (decision.action === "soft_downgrade") {
      if (scope === "task") {
        this.taskDowngrade.add(id);
      } else {
        this.threadDowngrade.add(id);
      }
      this.traceService.record({
        actor: "runtime.budget",
        eventType: "budget_warning",
        payload: {
          breachedLimit: decision.breachedLimit,
          mode: input.mode,
          reasons: decision.reasons,
          scope,
          taskId: input.taskId,
          threadId: input.threadId,
          usedCostUsd: state.usedCostUsd,
          usedInput: state.usedInput,
          usedOutput: state.usedOutput
        },
        stage: "control",
        summary: `Budget soft limit reached for ${scope}`,
        taskId: input.taskId
      });
      this.auditService.record({
        action: "budget_warning",
        actor: "runtime.budget",
        approvalId: null,
        outcome: "succeeded",
        payload: {
          breachedLimit: decision.breachedLimit,
          reasons: decision.reasons,
          scope,
          taskId: input.taskId,
          threadId: input.threadId
        },
        summary: `Budget warning for ${scope}`,
        taskId: input.taskId,
        toolCallId: null
      });
      return;
    }

    this.traceService.record({
      actor: "runtime.budget",
      eventType: "budget_exceeded",
      payload: {
        breachedLimit: decision.breachedLimit,
        mode: input.mode,
        reasons: decision.reasons,
        scope,
        taskId: input.taskId,
        threadId: input.threadId,
        usedCostUsd: state.usedCostUsd,
        usedInput: state.usedInput,
        usedOutput: state.usedOutput
      },
      stage: "control",
      summary: `Budget hard limit reached for ${scope}`,
      taskId: input.taskId
    });
    this.auditService.record({
      action: "budget_exceeded",
      actor: "runtime.budget",
      approvalId: null,
      outcome: "failed",
      payload: {
        breachedLimit: decision.breachedLimit,
        reasons: decision.reasons,
        scope,
        taskId: input.taskId,
        threadId: input.threadId
      },
      summary: `Budget exceeded for ${scope}`,
      taskId: input.taskId,
      toolCallId: null
    });
  }
}

function nextState(
  current: BudgetState | undefined,
  usage: ProviderUsage,
  costUsd: number | null
): BudgetState {
  return {
    usedCostUsd: (current?.usedCostUsd ?? 0) + (costUsd ?? 0),
    usedInput: (current?.usedInput ?? 0) + usage.inputTokens,
    usedOutput: (current?.usedOutput ?? 0) + usage.outputTokens
  };
}
