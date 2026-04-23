import React from "react";
import { Box, Text } from "ink";

import type { SelectedTaskViewModel } from "../view-models/runtime-dashboard.js";

export interface TaskPanelProps {
  selectedTask: SelectedTaskViewModel | null;
}

export function TaskPanel({ selectedTask }: TaskPanelProps): React.ReactElement {
  if (selectedTask === null) {
    return <Text color="yellow">No task selected.</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text color="cyan">Task Overview</Text>
      <Text>{selectedTask.finalSummary}</Text>
      <Box marginTop={1} flexDirection="column">
        {selectedTask.metadata.map((item) => (
          <Text key={item.label}>
            <Text color="gray">{item.label}:</Text> {item.value}
          </Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="cyan">Recent Events</Text>
        {selectedTask.recentEvents.length === 0 ? (
          <Text color="gray">No events yet.</Text>
        ) : (
          selectedTask.recentEvents.map((event, index) => <Text key={`${event}-${index}`}>- {event}</Text>)
        )}
      </Box>
    </Box>
  );
}
