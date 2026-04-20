import React from "react";
import { Box, Text } from "ink";

import { sanitizeTerminalText } from "../text-sanitize";
import { MarkdownContent } from "./markdown-content";

export function AgentMessage({
  streaming,
  text
}: {
  streaming?: boolean;
  text: string;
}): React.ReactElement {
  const safeText = sanitizeTerminalText(text);
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Agent:
      </Text>
      <MarkdownContent source={safeText} />
      {streaming === true ? (
        <Text color="gray" dimColor>
          ▌
        </Text>
      ) : null}
    </Box>
  );
}
