import React from "react";
import { Text } from "ink";

export function AgentMessage({ text }: { text: string }): React.ReactElement {
  return (
    <Text color="cyan" wrap="wrap">
      Agent: {text}
    </Text>
  );
}
