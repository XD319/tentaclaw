import React from "react";
import { Text } from "ink";

export function Spinner({ active }: { active: boolean }): React.ReactElement | null {
  if (!active) {
    return null;
  }

  return <Text color="yellow">thinking...</Text>;
}
