import React from "react";
import { Box, Text } from "ink";

import type { ApprovalRecord, ToolCallRecord } from "../../types";

export interface ApprovalCardProps {
  approval: ApprovalRecord;
  toolCall: ToolCallRecord | null;
}

export function ApprovalCard({ approval, toolCall }: ApprovalCardProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">Approval Required</Text>
      <Text>
        {approval.toolName} [{toolCall?.riskLevel ?? "unknown"}] task={approval.taskId.slice(0, 8)}
      </Text>
      <Text color="gray">reason: {approval.reason}</Text>
      <Text color="gray">Press [a] allow or [d] deny.</Text>
    </Box>
  );
}
