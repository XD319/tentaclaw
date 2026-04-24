import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme.js";
import type { TraceEntryViewModel } from "../view-models/runtime-dashboard.js";

export interface TracePanelProps {
  trace: TraceEntryViewModel[];
}

export function TracePanel({ trace }: TracePanelProps): React.ReactElement {
  const groups = groupByIteration(trace);

  return (
    <Box flexDirection="column">
      <Text color={theme.panelTitle}>Step Tree</Text>
      {trace.length === 0 ? (
        <Text color={theme.muted}>No trace recorded yet.</Text>
      ) : (
        groups.map((group) => (
          <Box key={group.label} borderStyle="classic" borderColor={theme.border} flexDirection="column" marginBottom={1} paddingX={1}>
            <Text color={theme.muted}>{group.label}</Text>
            {group.entries.map((entry) => (
              <Text
                key={`${entry.sequence}-${entry.eventType}-${entry.timestamp}`}
                {...traceTextProps(entry.emphasis)}
                wrap="wrap"
              >
                #{entry.sequence} [{entry.stage}] {entry.eventType} {entry.chainLabel ?? ""} {entry.summary}
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
): { color?: string } {
  if (emphasis === "error") {
    return { color: theme.danger };
  }

  if (emphasis === "warning") {
    return { color: theme.warn };
  }

  if (emphasis === "muted") {
    return { color: theme.muted };
  }

  return { color: theme.fg };
}
