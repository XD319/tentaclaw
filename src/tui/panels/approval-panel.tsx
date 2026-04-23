import React from "react";
import { Box, Text } from "ink";

import type { ApprovalListItemViewModel } from "../view-models/runtime-dashboard.js";

export interface ApprovalPanelProps {
  approvals: ApprovalListItemViewModel[];
  busy: boolean;
  selectedApprovalIndex: number;
}

export function ApprovalPanel({
  approvals,
  busy,
  selectedApprovalIndex
}: ApprovalPanelProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color="cyan">Pending Approvals</Text>
      {approvals.length === 0 ? (
        <Text color="gray">No approvals waiting.</Text>
      ) : (
        approvals.map((approval, index) => (
          <Text
            key={approval.approvalId}
            {...(index === selectedApprovalIndex ? { color: "green" as const } : {})}
          >
            {index === selectedApprovalIndex ? ">" : " "} {approval.toolName} [{approval.riskLevel}] task=
            {approval.taskId.slice(0, 8)} expires={approval.expiresAt} reason={approval.reason}
          </Text>
        ))
      )}
      <Box marginTop={1}>
        <Text color={busy ? "yellow" : "gray"}>
          {busy ? "Applying approval decision..." : "Use Up/Down to choose, a to allow, d to deny."}
        </Text>
      </Box>
    </Box>
  );
}
