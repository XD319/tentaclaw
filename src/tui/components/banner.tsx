import React from "react";
import { Box, Text } from "ink";

export interface BannerProps {
  cwd: string;
  modelLabel: string;
  sessionId: string;
  sessionTitle: string;
}

export function Banner({ cwd, modelLabel, sessionId, sessionTitle }: BannerProps): React.ReactElement {
  const compactCwd = cwd.length > 36 ? `...${cwd.slice(-33)}` : cwd;
  const title = sessionTitle.length > 28 ? `${sessionTitle.slice(0, 25)}...` : sessionTitle;
  const sid = sessionId.length > 10 ? `${sessionId.slice(0, 8)}…` : sessionId;
  return (
    <Box justifyContent="space-between">
      <Text color="green">
        auto-talon v0.1.0 | {title} · {sid}
      </Text>
      <Text color="gray">
        model={modelLabel} cwd={compactCwd}
      </Text>
    </Box>
  );
}
