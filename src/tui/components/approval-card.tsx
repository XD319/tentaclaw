import React from "react";
import { Box, Text } from "ink";

import type { ApprovalRecord, ToolCallRecord } from "../../types/index.js";
import { theme } from "../theme.js";

export interface ApprovalCardProps {
  approval: ApprovalRecord;
  toolCall: ToolCallRecord | null;
}

export function ApprovalCard({ approval, toolCall }: ApprovalCardProps): React.ReactElement {
  const target = summarizeToolTarget(toolCall);
  const targetText = target !== null ? ` | target ${target}` : "";

  return (
    <Box flexDirection="column" borderStyle="classic" borderColor={theme.warn} paddingX={1}>
      <Text color={theme.warn}>Approval required</Text>
      <Text color={theme.fg}>
        {approval.toolName} [{toolCall?.riskLevel ?? "unknown"}] task {approval.taskId.slice(0, 8)}
        {targetText}
      </Text>
      <Text color={theme.muted}>reason {approval.reason}</Text>
      <Text color={theme.muted}>a allow | d deny</Text>
    </Box>
  );
}

function summarizeToolTarget(toolCall: ToolCallRecord | null): string | null {
  if (toolCall === null) {
    return null;
  }

  const input = toolCall.input;
  const candidates = [
    input["url"],
    input["path"],
    input["command"],
    input["keyword"],
    input["query"]
  ];
  const value = candidates.find((item): item is string => typeof item === "string" && item.length > 0);
  if (value === undefined) {
    return null;
  }

  return value.length <= 96 ? value : `${value.slice(0, 93)}...`;
}
