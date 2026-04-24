import React from "react";
import { Box, Text } from "ink";

import { sanitizeTerminalText } from "../text-sanitize.js";
import { theme } from "../theme.js";
import { MarkdownContent } from "./markdown-content.js";
import { Spinner } from "./spinner.js";

export interface AgentMessageProps {
  streaming?: boolean;
  text: string;
}

function AgentMessageBase({ streaming, text }: AgentMessageProps): React.ReactElement {
  const safeText = React.useMemo(() => sanitizeTerminalText(text), [text]);
  const isStreaming = streaming === true;
  return (
    <Box flexDirection="column">
      <Text color={theme.agent}>
        assistant
      </Text>
      {isStreaming ? (
        <Text color={theme.fg} wrap="wrap">
          {safeText}
        </Text>
      ) : (
        <MarkdownContent source={safeText} />
      )}
      <Spinner active={isStreaming} />
    </Box>
  );
}

export const AgentMessage = React.memo(AgentMessageBase);
