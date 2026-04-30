import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme.js";
import type { HomeSummaryViewModel } from "../view-models/home-summary.js";

export interface HomeSummaryProps {
  summary: HomeSummaryViewModel;
}

function HomeSummaryBase({ summary }: HomeSummaryProps): React.ReactElement {
  return (
    <Box borderStyle="classic" borderColor={theme.border} flexDirection="column" paddingX={1}>
      <Text color={theme.panelTitle}>{summary.title}</Text>
      {summary.agenda.map((item, index) => (
        <Text key={`agenda:${index}`} color={index === 0 ? theme.fg : theme.muted} wrap="wrap">
          {index === 0 ? "> " : "- "}
          {item}
        </Text>
      ))}
      {summary.recommendedThread !== null ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.selection}>Continue recent thread</Text>
          <Text color={theme.fg} wrap="wrap">
            {summary.recommendedThread.label}
          </Text>
          <Text color={theme.muted} wrap="wrap">
            {summary.recommendedThread.headline}
          </Text>
          <Text color={theme.muted} wrap="wrap">
            {summary.recommendedThread.detail}
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.selection}>Recommended actions</Text>
        {summary.actions.map((action) => (
          <Box key={action.key} flexDirection="column">
            <Text color={theme.fg}>{action.label}</Text>
            <Text color={theme.muted} wrap="wrap">
              {action.detail}
            </Text>
          </Box>
        ))}
      </Box>
      <Text color={theme.muted} wrap="wrap">
        {summary.assistantHint}
      </Text>
    </Box>
  );
}

export const HomeSummary = React.memo(HomeSummaryBase);
