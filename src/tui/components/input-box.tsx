import React from "react";
import { Box, Text } from "ink";

export interface InputBoxProps {
  busy: boolean;
  lines: string[];
  value: string;
}

export function InputBox({ busy, lines, value }: InputBoxProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      {value.length === 0 ? (
        <Text color="gray">
          {busy
            ? "Agent is running..."
            : "Type a message... (Enter send, Alt+Enter/Ctrl+J newline, /help /status /title)"}
        </Text>
      ) : (
        lines.map((line, index) => <Text key={`line:${index}`}>{line}</Text>)
      )}
    </Box>
  );
}
