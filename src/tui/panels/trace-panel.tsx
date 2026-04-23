import React from "react";
import { Box, Text } from "ink";

import type { TraceEntryViewModel } from "../view-models/runtime-dashboard.js";

export interface TracePanelProps {
  trace: TraceEntryViewModel[];
}

export function TracePanel({ trace }: TracePanelProps): React.ReactElement {
  const groups = groupByIteration(trace);

  return (
    <Box flexDirection="column">
      <Text color="cyan">Step Tree</Text>
      {trace.length === 0 ? (
        <Text color="gray">No trace recorded yet.</Text>
      ) : (
        groups.map((group) => (
          <Box key={group.label} flexDirection="column" marginBottom={1}>
            <Text color="gray">{group.label}</Text>
            {group.entries.map((entry) => (
              <Text
                key={`${entry.sequence}-${entry.eventType}-${entry.timestamp}`}
                {...traceTextProps(entry.emphasis)}
              >
                {'  '}#{entry.sequence} [{entry.stage}] {entry.eventType} {entry.chainLabel ?? ""} {entry.summary}
              </Text>
            ))}
          </Box>
        ))
      )}
    </Box>
  );
}

function groupByIteration(trace: TraceEntryViewModel[]): Array<{
  entries: TraceEntryViewModel[];
  label: string;
}> {
  const groups = new Map<string, TraceEntryViewModel[]>();
  for (const entry of trace) {
    const label = entry.iteration === null ? "setup / completion" : `iteration ${entry.iteration}`;
    groups.set(label, [...(groups.get(label) ?? []), entry]);
  }
  return [...groups.entries()].map(([label, entries]) => ({ entries, label }));
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
