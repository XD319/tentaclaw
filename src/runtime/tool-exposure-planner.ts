import { checkToolAvailability } from "../tools/availability/index.js";
import { evaluateToolExposure } from "../tools/policy/index.js";
import type { ToolOrchestrator } from "../tools/tool-orchestrator.js";
import type { TraceService } from "../tracing/trace-service.js";
import type {
  ThreadCommitmentState,
  ToolExposurePlan,
  ToolExecutionContext
} from "../types/index.js";
import type { BudgetService } from "./budget/budget-service.js";

export interface ToolExposurePlannerDependencies {
  toolOrchestrator: ToolOrchestrator;
  traceService: TraceService;
  budgetService?: BudgetService;
}

export interface ToolExposurePlannerInput {
  taskId: string;
  threadId: string | null;
  iteration: number;
  taskInput: string;
  agentProfileId: string;
  allowedToolNames: string[];
  context: ToolExecutionContext;
  threadCommitmentState: ThreadCommitmentState | null;
}

export class ToolExposurePlanner {
  public constructor(private readonly dependencies: ToolExposurePlannerDependencies) {}

  public async plan(input: ToolExposurePlannerInput): Promise<ToolExposurePlan> {
    const tools = this.dependencies.toolOrchestrator.listToolsWithMetadata();
    const availability = await checkToolAvailability(tools, input.context);
    const budgetDowngradeActive =
      this.dependencies.budgetService?.isDowngradeActive("task", input.taskId) === true ||
      (input.threadId !== null &&
        this.dependencies.budgetService?.isDowngradeActive("thread", input.threadId) === true);
    const decisions = evaluateToolExposure({
      allowedToolNames: input.allowedToolNames,
      availability,
      budgetDowngradeActive,
      iteration: input.iteration,
      taskInput: input.taskInput,
      threadCommitmentState: input.threadCommitmentState,
      tools
    });
    const exposedNames = decisions.filter((d) => d.exposed).map((d) => d.toolName);
    const exposedTools = this.dependencies.toolOrchestrator.listTools(exposedNames);
    const hiddenTools = decisions.filter((d) => !d.exposed).map((d) => d.toolName);
    const plannerReasons = decisions.map((d) => `${d.toolName}:${d.reason}`);

    if (
      input.iteration === 1 ||
      hiddenTools.length > 0 ||
      decisions.some((decision) => decision.costWarning === true)
    ) {
      this.dependencies.traceService.record({
        actor: "runtime.tool_exposure",
        eventType: "tool_exposure_decided",
        payload: {
          decisions,
          exposedTools: exposedNames,
          hiddenTools,
          iteration: input.iteration,
          reasons: plannerReasons,
          taskId: input.taskId
        },
        stage: "planning",
        summary: `Tool exposure selected ${exposedNames.length} tools`,
        taskId: input.taskId
      });
    }

    return {
      decisions,
      plannerReasons,
      tools: exposedTools
    };
  }
}
