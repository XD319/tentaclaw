import type { ToolAvailabilityResult, ToolDefinition, ToolExposureDecision } from "../../types/index.js";

export interface EvaluateToolExposureInput {
  tools: ToolDefinition[];
  availability: Map<string, ToolAvailabilityResult>;
  budgetDowngradeActive: boolean;
}

export function evaluateToolExposure(input: EvaluateToolExposureInput): ToolExposureDecision[] {
  return input.tools.map((tool) => {
    const availability = input.availability.get(tool.name);
    if (availability?.available === false) {
      return hidden(tool.name, `unavailable: ${availability.reason}`);
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
