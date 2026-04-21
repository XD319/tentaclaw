import React from "react";
import { Box, Text } from "ink";

import type { DiffViewModel } from "../view-models/runtime-dashboard";

export interface DiffPanelProps {
  diff: DiffViewModel[];
}

export function DiffPanel({ diff }: DiffPanelProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color="cyan">File Diff</Text>
      {diff.length === 0 ? (
        <Text color="gray">No file write artifacts for this task.</Text>
      ) : (
        diff.map((entry) => (
          <Box key={entry.artifactId} marginBottom={1} flexDirection="column">
            <Text color={entry.riskHighlight ? "red" : "green"}>
              {entry.path} | {entry.summary}
            </Text>
            {entry.riskReasons.length > 0 ? (
              <Text color="yellow">risk: {entry.riskReasons.join("; ")}</Text>
            ) : null}
            {entry.unifiedDiff.length > 0 ? (
              entry.unifiedDiff.split(/\r?\n/u).slice(0, 80).map((line, index) => (
                <Text key={`${entry.artifactId}-diff-${index}`} {...diffLineProps(line)}>
                  {line}
                </Text>
              ))
            ) : (
              <>
                <Text color="gray">before: {entry.beforePreview.replace(/\n/gu, " ")}</Text>
                <Text color="gray">after: {entry.afterPreview.replace(/\n/gu, " ")}</Text>
              </>
            )}
          </Box>
        ))
      )}
    </Box>
  );
}

function diffLineProps(line: string): { color?: "gray" | "green" | "red" } {
  if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("@@")) {
    return { color: "gray" };
  }
  if (line.startsWith("+")) {
    return { color: "green" };
  }
  if (line.startsWith("-")) {
    return { color: "red" };
  }
  return {};
}
