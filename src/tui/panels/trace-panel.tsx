import React from "react";
import { Box, Text } from "ink";

import type { TraceEntryViewModel } from "../view-models/runtime-dashboard";

export interface TracePanelProps {
  trace: TraceEntryViewModel[];
}

export function TracePanel({ trace }: TracePanelProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color="cyan">Structured Trace</Text>
      {trace.length === 0 ? (
        <Text color="gray">No trace recorded yet.</Text>
      ) : (
        trace.map((entry) => (
          <Text
            key={`${entry.sequence}-${entry.eventType}`}
            {...traceTextProps(entry.emphasis)}
          >
            #{entry.sequence} [{entry.stage}] {entry.eventType} {entry.chainLabel ?? ""} {entry.summary}
          </Text>
        ))
      )}
    </Box>
  );
}

function traceTextProps(
  emphasis: TraceEntryViewModel["emphasis"]
): { color?: "gray" | "red" | "yellow" } {
  if (emphasis === "error") {
    return { color: "red" };
  }

  if (emphasis === "warning") {
    return { color: "yellow" };
  }

  if (emphasis === "muted") {
    return { color: "gray" };
  }

  return {};
}
