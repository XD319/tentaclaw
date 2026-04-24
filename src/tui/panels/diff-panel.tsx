import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme.js";
import type { DiffViewModel } from "../view-models/runtime-dashboard.js";

export interface DiffPanelProps {
  diff: DiffViewModel[];
}

export function DiffPanel({ diff }: DiffPanelProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color={theme.panelTitle}>File Diff</Text>
      {diff.length === 0 ? (
        <Text color={theme.muted}>No file write artifacts for this task.</Text>
      ) : (
        diff.map((entry) => (
          <Box key={entry.artifactId} borderStyle="classic" borderColor={theme.border} marginBottom={1} flexDirection="column" paddingX={1}>
            <Text color={entry.riskHighlight ? theme.danger : theme.success}>
              {entry.path} | {entry.summary}
            </Text>
            {entry.riskReasons.length > 0 ? (
              <Text color={theme.warn} wrap="wrap">
                risk: {entry.riskReasons.join("; ")}
              </Text>
            ) : null}
            {entry.unifiedDiff.length > 0 ? (
              entry.unifiedDiff.split(/\r?\n/u).slice(0, 40).map((line, index) => (
                <Text key={`${entry.artifactId}-diff-${index}`} {...diffLineProps(line)}>
                  {line}
                </Text>
              ))
            ) : (
              <>
                <Text color={theme.muted}>before: {entry.beforePreview.replace(/\n/gu, " ")}</Text>
                <Text color={theme.muted}>after: {entry.afterPreview.replace(/\n/gu, " ")}</Text>
              </>
            )}
          </Box>
        ))
      )}
    </Box>
  );
}

function diffLineProps(line: string): { color?: string } {
  if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("@@")) {
    return { color: theme.muted };
  }
  if (line.startsWith("+")) {
    return { color: theme.success };
  }
  if (line.startsWith("-")) {
    return { color: theme.danger };
  }
  return {};
}
