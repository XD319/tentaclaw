import React from "react";
import { Text } from "ink";

export function UserMessage({ text }: { text: string }): React.ReactElement {
  return (
    <Text color="green" wrap="wrap">
      {">"} {text}
    </Text>
  );
}
