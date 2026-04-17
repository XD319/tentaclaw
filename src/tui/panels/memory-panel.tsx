import React from "react";
import { Box, Text } from "ink";

import type { MemoryHitViewModel } from "../view-models/runtime-dashboard";

export interface MemoryPanelProps {
  memoryHits: MemoryHitViewModel[];
}

export function MemoryPanel({ memoryHits }: MemoryPanelProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color="cyan">Memory Hits</Text>
      {memoryHits.length === 0 ? (
        <Text color="gray">No memory recall recorded for this task.</Text>
      ) : (
        memoryHits.map((hit) => (
          <Box key={hit.memoryId} marginBottom={1} flexDirection="column">
            <Text color={hit.selected ? "green" : "yellow"}>
              {hit.title} [{hit.scope}] conf={hit.confidence.toFixed(2)} status={hit.status}
            </Text>
            <Text color="gray">source: {hit.source}</Text>
            <Text color={hit.downgraded ? "yellow" : "gray"}>{hit.reasons.join("; ")}</Text>
          </Box>
        ))
      )}
    </Box>
  );
}
