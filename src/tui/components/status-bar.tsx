import React from "react";
import { Box, Text } from "ink";

import { contextUsageColor } from "../token-pricing";
import { theme } from "../theme";

export interface StatusBarProps {
  atBottom: boolean;
  contextPercent: number;
  estimatedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  pendingApprovals: number;
  runDurationLabel: string;
  runningTasks: number;
  statusLine: string;
  taskCount: number;
}

export function StatusBar({
  atBottom,
  contextPercent,
  estimatedCostUsd,
  inputTokens,
  outputTokens,
  pendingApprovals,
  runDurationLabel,
  runningTasks,
  statusLine,
  taskCount
}: StatusBarProps): React.ReactElement {
  const ctxColor = contextUsageColor(contextPercent);
  const costLabel = estimatedCostUsd < 0.000_5 ? "~$0.00" : `~$${estimatedCostUsd.toFixed(4)}`;

  return (
    <Box flexDirection="column">
      <Text wrap="wrap">
        <Text color={theme.muted}>│ </Text>
        <Text color="gray">
          tasks {taskCount} · run {runningTasks} · appr {pendingApprovals} · {runDurationLabel}
        </Text>
        <Text color={theme.muted}> │ </Text>
        <Text color="gray">
          tok in {inputTokens} out {outputTokens}
        </Text>
        <Text color={theme.muted}> │ </Text>
        <Text color={ctxColor}>
          ctx {contextPercent}%
        </Text>
        <Text color={theme.muted}> │ </Text>
        <Text color="yellow">{costLabel}</Text>
        <Text color={theme.muted}> │ </Text>
        <Text color="gray">scroll {atBottom ? "follow" : "paused"}</Text>
        <Text color={theme.muted}> │ </Text>
        <Text color="cyan">{statusLine}</Text>
      </Text>
    </Box>
  );
}
