import type {
  AdapterCapabilityDeclaration,
  AdapterCapabilityName,
  GatewayCapabilityNotice,
  GatewayTaskRequest,
  TaskRecord
} from "../types/index.js";

export function collectCapabilityNotices(
  adapterId: string,
  capabilities: AdapterCapabilityDeclaration,
  request: GatewayTaskRequest,
  task: TaskRecord
): GatewayCapabilityNotice[] {
  const notices: GatewayCapabilityNotice[] = [];
  const requirements = request.interactionRequirements ?? {};

  for (const capability of Object.keys(requirements) as AdapterCapabilityName[]) {
    const support = capabilities[capability];
    if (support.supported) {
      continue;
    }

    notices.push({
      capability,
      fallbackBehavior: describeFallback(capability, task.status),
      message: `${adapterId} does not support ${capability}. ${support.detail ?? "Using fallback behavior."}`,
      severity: requirements[capability] === "required" ? "warning" : "info"
    });
  }

  if (!capabilities.approvalInteraction.supported && task.status === "waiting_approval") {
    notices.push({
      capability: "approvalInteraction",
      fallbackBehavior: "Return the pending task and resolve approval through another governed surface.",
      message: `${adapterId} cannot resolve approvals inline, so the task remains in waiting_approval.`,
      severity: "warning"
    });
  }

  return dedupeNotices(notices);
}

function describeFallback(
  capability: AdapterCapabilityName,
  taskStatus: string
): string {
  switch (capability) {
    case "streamingCapability":
      return "Return buffered task state and let clients poll or fetch the event history later.";
    case "structuredCardCapability":
      return "Return plain text summaries instead of structured cards.";
    case "fileCapability":
      return "Return artifact references instead of inline file transfer.";
    case "attachmentCapability":
      return "Return attachment and artifact references instead of inline attachment upload.";
    case "approvalInteraction":
      return taskStatus === "waiting_approval"
        ? "Leave the task pending approval and surface the approval identifier."
        : "Return approval metadata without inline interaction.";
    case "textInteraction":
      return "Reject adapter startup because text interaction is the minimum supported contract.";
    default:
      return "Use the minimal text-based fallback.";
  }
}

function dedupeNotices(notices: GatewayCapabilityNotice[]): GatewayCapabilityNotice[] {
  const seen = new Set<string>();
  return notices.filter((notice) => {
    const key = `${notice.capability}:${notice.message}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}
