import React from "react";
import { Box, Text } from "ink";

import { sanitizeTerminalText } from "../text-sanitize.js";
import { MarkdownContent } from "./markdown-content.js";

export interface AgentMessageProps {
  streaming?: boolean;
  text: string;
}

function AgentMessageBase({ streaming, text }: AgentMessageProps): React.ReactElement {
  const safeText = React.useMemo(() => sanitizeTerminalText(text), [text]);
  const isStreaming = streaming === true;
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Agent:
      </Text>
      {isStreaming ? (
        <Text wrap="wrap">{safeText}</Text>
      ) : (
        <MarkdownContent source={safeText} />
      )}
      {isStreaming ? (
        <Text color="gray" dimColor>
          ...
        </Text>
      ) : null}
    </Box>
  );
}

export const AgentMessage = React.memo(AgentMessageBase);
