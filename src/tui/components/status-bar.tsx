import React from "react";
import { Box, Text } from "ink";

import { contextUsageColor } from "../token-pricing.js";
import { theme } from "../theme.js";

export interface StatusBarProps {
  contextPercent: number;
  estimatedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  statusLine: string;
}

function StatusBarBase({
  contextPercent,
  estimatedCostUsd,
  inputTokens,
  outputTokens,
  statusLine
}: StatusBarProps): React.ReactElement {
  const ctxColor = contextUsageColor(contextPercent);
  const costLabel = estimatedCostUsd < 0.000_5 ? "~$0.00" : `~$${estimatedCostUsd.toFixed(4)}`;
  const separator = " | ";

  return (
    <Box flexDirection="column">
      <Text wrap="wrap">
        <Text color="gray">
          tok in {inputTokens} out {outputTokens}
        </Text>
        <Text color={theme.muted}>{separator}</Text>
        <Text color={ctxColor}>ctx {contextPercent}%</Text>
        <Text color={theme.muted}>{separator}</Text>
        <Text color="yellow">{costLabel}</Text>
        <Text color={theme.muted}>{separator}</Text>
        <Text color="cyan">{statusLine}</Text>
      </Text>
    </Box>
  );
}

export const StatusBar = React.memo(StatusBarBase);
