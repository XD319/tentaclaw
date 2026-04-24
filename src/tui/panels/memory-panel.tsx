import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme.js";
import type { MemoryHitViewModel } from "../view-models/runtime-dashboard.js";

export interface MemoryPanelProps {
  memoryHits: MemoryHitViewModel[];
}

export function MemoryPanel({ memoryHits }: MemoryPanelProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color={theme.panelTitle}>Memory Hits</Text>
      {memoryHits.length === 0 ? (
        <Text color={theme.muted}>No memory recall recorded for this task.</Text>
      ) : (
        memoryHits.map((hit) => (
          <Box key={hit.memoryId} borderStyle="classic" borderColor={theme.border} marginBottom={1} flexDirection="column" paddingX={1}>
            <Text color={hit.selected ? theme.success : theme.warn}>
              {hit.title} [{hit.scope}] conf={hit.confidence.toFixed(2)} status={hit.status}
            </Text>
            <Text color={theme.muted}>source: {hit.source}</Text>
            <Text color={hit.downgraded ? theme.warn : theme.muted} wrap="wrap">
              {hit.reasons.join("; ")}
            </Text>
          </Box>
        ))
      )}
    </Box>
  );
}
