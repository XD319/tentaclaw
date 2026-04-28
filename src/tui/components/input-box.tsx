import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme.js";
import type { SlashSuggestion } from "../slash-commands.js";

export interface InputBoxProps {
  busy: boolean;
  collapsePreview?: { charCount: number; lineCount: number; previewLines: string[] } | null;
  hasPendingApproval: boolean;
  isCollapsed?: boolean;
  lines: string[];
  queuedPromptCount?: number;
  slashHints?: SlashSuggestion[];
  value: string;
}

function InputBoxBase({
  busy,
  collapsePreview = null,
  hasPendingApproval,
  isCollapsed = false,
  lines,
  queuedPromptCount = 0,
  slashHints = [],
  value
}: InputBoxProps): React.ReactElement {
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
        <>
          {(isCollapsed && collapsePreview !== null ? buildCollapsedLines(collapsePreview) : lines).map((line, index) => (
            <Text key={`line:${index}`}>
              <Text color={promptColor}>{index === 0 ? "> " : "  "}</Text>
              <Text color={theme.fg}>{line}</Text>
            </Text>
          ))}
          {isCollapsed && collapsePreview !== null ? (
            <Text color={theme.muted}>
              pasted {collapsePreview.lineCount} lines / {collapsePreview.charCount} chars | `Alt+P` expand | `Ctrl+O` edit
            </Text>
          ) : null}
        </>
      )}
      {queuedPromptCount > 0 ? <Text color={theme.muted}>queue: {queuedPromptCount} waiting</Text> : null}
      {slashHints.length > 0 ? (
        <Box flexDirection="column">
          {slashHints.slice(0, 6).map((hint) => (
            <Text key={hint.key} color={theme.muted} wrap="wrap">
              {hint.label} - {hint.description}
            </Text>
          ))}
        </Box>
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
    return "assistant is running... queued messages will auto-send";
  }
  return "Type a message... (/help)";
}

function buildCollapsedLines(preview: { charCount: number; lineCount: number; previewLines: string[] }): string[] {
  const visible = preview.previewLines.length > 0 ? preview.previewLines : [""];
  if (preview.lineCount > preview.previewLines.length) {
    return [...visible, `... ${preview.lineCount - preview.previewLines.length} more lines`];
  }
  return visible;
}
