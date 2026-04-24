import React from "react";
import { Text } from "ink";

function SpinnerBase({ active }: { active: boolean }): React.ReactElement | null {
  if (!active) {
    return null;
  }

  return <Text color="yellow">Thinking...</Text>;
}

export const Spinner = React.memo(SpinnerBase);
