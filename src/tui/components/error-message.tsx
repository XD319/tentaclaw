import React from "react";
import { Text } from "ink";

export interface ErrorMessageProps {
  code: string;
  message: string;
  source: string;
}

export function ErrorMessage({ code, message, source }: ErrorMessageProps): React.ReactElement {
  const compact = message.replace(/\s+/gu, " ").trim();
  const preview = compact.length > 180 ? `${compact.slice(0, 180)}...` : compact;
  return (
    <Text color="red">
      [{source}] {code}: {preview}
    </Text>
  );
}
