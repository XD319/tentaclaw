import type { ContextFragment, ProviderToolDescriptor } from "../types/index.js";

export function buildCapabilityDeclaration(input: {
  agentProfileId: string;
  availableTools: ProviderToolDescriptor[];
  costWarnedToolNames?: string[];
  skillContext: ContextFragment[];
}): string {
  const warnedTools = new Set(input.costWarnedToolNames ?? []);
  const toolLines = input.availableTools.map(
    (tool) =>
      `${tool.name}${warnedTools.has(tool.name) ? " [cost_warning]" : ""} :: capability=${tool.capability} risk=${tool.riskLevel} privacy=${tool.privacyLevel} schema=${JSON.stringify(tool.inputSchema)}`
  );
  const skillLines = input.skillContext
    .filter((fragment) => fragment.memoryId.startsWith("skill:"))
    .map((fragment) => `${fragment.memoryId} :: ${fragment.text}`);

  return [
    "Capability declarations (re-injected after compact):",
    `agent_profile=${input.agentProfileId}`,
    "tools:",
    ...(toolLines.length > 0 ? toolLines : ["[none]"]),
    "skills:",
    ...(skillLines.length > 0 ? skillLines : ["[none]"])
  ].join("\n");
}
