import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme.js";
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
      <Text color={theme.panelTitle}>Pending Approvals</Text>
      {approvals.length === 0 ? (
        <Text color={theme.muted}>No approvals waiting.</Text>
      ) : (
        approvals.map((approval, index) => (
          <Box
            key={approval.approvalId}
            borderStyle="classic"
            borderColor={index === selectedApprovalIndex ? theme.selection : theme.border}
            flexDirection="column"
            marginBottom={1}
            paddingX={1}
          >
            <Text color={index === selectedApprovalIndex ? theme.selection : theme.fg}>
              {approval.toolName} [{approval.riskLevel}] task={approval.shortTaskId}
            </Text>
            <Text color={theme.muted}>expires {approval.expiresLabel}</Text>
            <Text color={theme.muted} wrap="wrap">
              {approval.taskLabel}
            </Text>
            <Text color={theme.fg} wrap="wrap">
              {approval.reason}
            </Text>
          </Box>
        ))
      )}
      <Box marginTop={1}>
        <Text color={busy ? theme.warn : theme.muted}>
          {busy ? "Applying approval decision..." : "Use Up/Down to choose, a to allow, d to deny."}
        </Text>
      </Box>
    </Box>
  );
}
