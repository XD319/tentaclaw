import React from "react";
import { Text } from "ink";

export interface StatusBarProps {
  atBottom: boolean;
  pendingApprovals: number;
  runDurationLabel: string;
  runningTasks: number;
  statusLine: string;
  taskCount: number;
}

export function StatusBar({
  atBottom,
  pendingApprovals,
  runDurationLabel,
  runningTasks,
  statusLine,
  taskCount
}: StatusBarProps): React.ReactElement {
  return (
    <Text color="gray">
      tasks={taskCount} running={runningTasks} approvals={pendingApprovals} elapsed={runDurationLabel} scroll=
      {atBottom ? "follow" : "paused"} status={statusLine}
    </Text>
  );
}
