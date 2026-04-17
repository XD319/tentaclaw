import React from "react";
import { Box, Text } from "ink";

import type { ErrorViewModel } from "../view-models/runtime-dashboard";

export interface ErrorsPanelProps {
  errors: ErrorViewModel[];
}

export function ErrorsPanel({ errors }: ErrorsPanelProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color="cyan">Errors And Retries</Text>
      {errors.length === 0 ? (
        <Text color="gray">No failures, retries, interrupts, or policy rejects.</Text>
      ) : (
        errors.map((entry, index) => (
          <Text key={`${entry.code}-${index}`} color="red">
            [{entry.source}] {entry.code} {entry.message}
          </Text>
        ))
      )}
    </Box>
  );
}
