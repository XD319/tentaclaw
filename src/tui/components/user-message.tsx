import React from "react";
import { Text } from "ink";

import { sanitizeTerminalText } from "../text-sanitize";

export function UserMessage({ text }: { text: string }): React.ReactElement {
  const safeText = sanitizeTerminalText(text);
  return (
    <Text color="green" wrap="wrap">
      {">"} {safeText}
    </Text>
  );
}
