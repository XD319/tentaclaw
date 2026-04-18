import React from "react";
import { Text } from "ink";

const FRAMES = ["-", "\\", "|", "/"];

export function Spinner({ active }: { active: boolean }): React.ReactElement | null {
  const [index, setIndex] = React.useState(0);

  React.useEffect(() => {
    if (!active) {
      return;
    }
    const interval = setInterval(() => {
      setIndex((current) => (current + 1) % FRAMES.length);
    }, 120);
    return () => {
      clearInterval(interval);
    };
  }, [active]);

  if (!active) {
    return null;
  }

  return <Text color="yellow">{FRAMES[index]} thinking...</Text>;
}
