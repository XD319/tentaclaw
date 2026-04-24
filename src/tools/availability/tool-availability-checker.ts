import type { ToolAvailabilityResult, ToolDefinition, ToolExecutionContext } from "../../types/index.js";

export async function checkToolAvailability(
  tools: ToolDefinition[],
  context: ToolExecutionContext
): Promise<Map<string, ToolAvailabilityResult>> {
  const results = new Map<string, ToolAvailabilityResult>();
  for (const tool of tools) {
    if (tool.checkAvailability === undefined) {
      results.set(tool.name, {
        available: true,
        reason: "no check"
      });
      continue;
    }
    const result = await tool.checkAvailability(context);
    results.set(tool.name, result);
  }
  return results;
}
