import React from "react";
import { Text } from "ink";

export function ToolActivity({ text }: { text: string }): React.ReactElement {
  const compact = text.replace(/\s+/gu, " ").trim();
  const preview = compact.length > 140 ? `${compact.slice(0, 140)}...` : compact;
  return <Text color="gray">┊ {preview}</Text>;
}
