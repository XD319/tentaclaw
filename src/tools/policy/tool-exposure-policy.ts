import type {
  ThreadCommitmentState,
  ToolAvailabilityResult,
  ToolDefinition,
  ToolExposureDecision
} from "../../types/index.js";

export interface EvaluateToolExposureInput {
  tools: ToolDefinition[];
  allowedToolNames: string[];
  availability: Map<string, ToolAvailabilityResult>;
  budgetDowngradeActive: boolean;
  iteration: number;
  taskInput: string;
  threadCommitmentState: ThreadCommitmentState | null;
}

export function evaluateToolExposure(input: EvaluateToolExposureInput): ToolExposureDecision[] {
  return input.tools.map((tool) => {
    if (!input.allowedToolNames.includes(tool.name)) {
      return hidden(tool.name, "not in profile allowlist");
    }

    const availability = input.availability.get(tool.name);
    if (availability?.available === false) {
      return hidden(tool.name, `unavailable: ${availability.reason}`);
    }

    if (
      tool.riskLevel === "high" &&
      input.iteration <= 1 &&
      !hasMutationIntent(input.taskInput)
    ) {
      return hidden(tool.name, "high risk hidden at initial iteration without mutation intent");
    }

    if (
      input.threadCommitmentState?.pendingDecision !== null &&
      input.threadCommitmentState?.pendingDecision !== undefined &&
      (tool.sideEffectLevel === "workspace_mutation" || tool.sideEffectLevel === "external_mutation")
    ) {
      return hidden(tool.name, "mutation tools hidden while thread has pending decision");
    }

    if (input.budgetDowngradeActive && tool.costLevel === "expensive") {
      return {
        costWarning: true,
        exposed: true,
        reason: "budget downgrade active",
        toolName: tool.name
      };
    }

    return {
      exposed: true,
      reason: "eligible",
      toolName: tool.name
    };
  });
}

function hidden(toolName: string, reason: string): ToolExposureDecision {
  return {
    exposed: false,
    reason,
    toolName
  };
}

function hasMutationIntent(taskInput: string): boolean {
  return /\b(write|edit|modify|patch|delete|remove|create|update|refactor|fix|run|test|command|shell)\b/i.test(
    taskInput
  );
}
