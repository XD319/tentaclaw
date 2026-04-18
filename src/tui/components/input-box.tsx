import React from "react";
import { Box, Text } from "ink";

export interface InputBoxProps {
  busy: boolean;
  cursorIndex: number;
  lines: string[];
  value: string;
}

export function InputBox({ busy, cursorIndex, lines, value }: InputBoxProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      {value.length === 0 ? (
        <Text color="gray">
          {busy
            ? "Agent is running..."
            : "Type a message... (Meta+Enter send, Ctrl+A/E/W edit, Ctrl+P/N history, /help commands)"}
        </Text>
      ) : (
        lines.map((line, index) => <Text key={`line:${index}`}>{line}</Text>)
      )}
      <Text color="gray">cursor={cursorIndex}</Text>
    </Box>
  );
}
