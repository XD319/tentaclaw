import React from "react";
import { Box, Text } from "ink";

import { MarkdownContent } from "./markdown-content";

export function AgentMessage({
  streaming,
  text
}: {
  streaming?: boolean;
  text: string;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Agent:
      </Text>
      <MarkdownContent source={text} />
      {streaming === true ? (
        <Text color="gray" dimColor>
          ▌
        </Text>
      ) : null}
    </Box>
  );
}
