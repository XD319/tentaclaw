import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme.js";
import type { ErrorViewModel } from "../view-models/runtime-dashboard.js";

export interface ErrorsPanelProps {
  errors: ErrorViewModel[];
}

export function ErrorsPanel({ errors }: ErrorsPanelProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color={theme.panelTitle}>Errors And Retries</Text>
      {errors.length === 0 ? (
        <Text color={theme.muted}>No failures, retries, interrupts, or policy rejects.</Text>
      ) : (
        errors.map((entry, index) => (
          <Box key={`${entry.code}-${index}`} borderStyle="classic" borderColor={theme.danger} flexDirection="column" marginBottom={1} paddingX={1}>
            <Text color={theme.danger}>
              [{entry.source}] {entry.code}
            </Text>
            <Text color={theme.fg} wrap="wrap">
              {entry.message}
            </Text>
          </Box>
        ))
      )}
    </Box>
  );
}
