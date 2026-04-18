import React from "react";
import { Box, Text } from "ink";

export interface BannerProps {
  cwd: string;
  modelLabel: string;
}

export function Banner({ cwd, modelLabel }: BannerProps): React.ReactElement {
  const compactCwd = cwd.length > 36 ? `...${cwd.slice(-33)}` : cwd;
  return (
    <Box justifyContent="space-between">
      <Text color="green">auto-talon v0.1.0 chat</Text>
      <Text color="gray">
        model={modelLabel} cwd={compactCwd}
      </Text>
    </Box>
  );
}
