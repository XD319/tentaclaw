import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme.js";

export interface InputBoxProps {
  busy: boolean;
  hasPendingApproval: boolean;
  lines: string[];
  slashHints?: string[];
  value: string;
}

function InputBoxBase({ busy, hasPendingApproval, lines, slashHints = [], value }: InputBoxProps): React.ReactElement {
  const placeholder = getPlaceholderText(busy, hasPendingApproval);
  const promptColor = hasPendingApproval ? theme.warn : busy ? theme.accent : theme.selection;

  return (
    <Box flexDirection="column">
      {value.length === 0 ? (
        <Text>
          <Text color={promptColor}>{"> "}</Text>
          <Text color={theme.muted}>{placeholder}</Text>
        </Text>
      ) : (
        lines.map((line, index) => (
          <Text key={`line:${index}`}>
            <Text color={promptColor}>{index === 0 ? "> " : "  "}</Text>
            <Text color={theme.fg}>{line}</Text>
          </Text>
        ))
      )}
      {slashHints.length > 0 ? (
        <Text color={theme.muted} wrap="wrap">
          hints: {slashHints.slice(0, 6).join("  |  ")}
        </Text>
      ) : null}
    </Box>
  );
}

export const InputBox = React.memo(InputBoxBase);

function getPlaceholderText(busy: boolean, hasPendingApproval: boolean): string {
  if (hasPendingApproval) {
    return "approval pending (a allow, d deny)";
  }
  if (busy) {
    return "assistant is running...";
  }
  return "Type a message... (/help)";
}
