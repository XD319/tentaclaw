import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme.js";
import type { SelectedTaskViewModel } from "../view-models/runtime-dashboard.js";

export interface TaskPanelProps {
  selectedTask: SelectedTaskViewModel | null;
}

export function TaskPanel({ selectedTask }: TaskPanelProps): React.ReactElement {
  if (selectedTask === null) {
    return <Text color={theme.warn}>No task selected.</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text color={theme.panelTitle}>Task Overview</Text>
      <Box borderStyle="classic" borderColor={theme.border} flexDirection="column" paddingX={1}>
        <Text color={theme.fg} wrap="wrap">
          {selectedTask.finalSummary}
        </Text>
        {selectedTask.metadata.map((item) => (
          <Text key={item.label} wrap="wrap">
            <Text color={theme.muted}>{item.label}:</Text> {item.value}
          </Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.panelTitle}>Recent Events</Text>
        {selectedTask.recentEvents.length === 0 ? (
          <Text color={theme.muted}>No events yet.</Text>
        ) : (
          selectedTask.recentEvents.map((event, index) => (
            <Box key={`${event}-${index}`} borderStyle="classic" borderColor={theme.border} flexDirection="column" marginBottom={1} paddingX={1}>
              <Text color={theme.fg} wrap="wrap">
                {event}
              </Text>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}
