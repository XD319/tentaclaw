import React from "react";
import { Text } from "ink";

import { sanitizeTerminalText } from "../text-sanitize";

export function ToolActivity({ text }: { text: string }): React.ReactElement {
  const compact = sanitizeTerminalText(text).replace(/\s+/gu, " ").trim();
  const preview = compact.length > 140 ? `${compact.slice(0, 140)}...` : compact;
  return <Text color="gray">| {preview}</Text>;
}
