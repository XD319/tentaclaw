import React from "react";
import { Box, Text, useApp, useInput } from "ink";

import { useDashboardController, nextPanel, previousPanel } from "./hooks/use-dashboard-controller";
import {
  ApprovalPanel,
  DiffPanel,
  ErrorsPanel,
  MemoryPanel,
  TaskPanel,
  TracePanel
} from "./panels";
import {
  PANEL_ORDER,
  type RuntimeDashboardQueryService,
  type TuiPanelId
} from "./view-models/runtime-dashboard";

export interface AgentTuiAppProps {
  queryService: RuntimeDashboardQueryService;
  refreshIntervalMs?: number;
  reviewerId: string;
}

export function AgentTuiApp({
  queryService,
  refreshIntervalMs = 2_000,
  reviewerId
}: AgentTuiAppProps): React.ReactElement {
  const { exit } = useApp();
  const controller = useDashboardController({
    queryService,
    refreshIntervalMs,
    reviewerId
  });

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      exit();
      return;
    }

    if (key.tab && key.shift) {
      controller.setSelectedPanel((current) => previousPanel(current));
      return;
    }

    if (key.tab) {
      controller.setSelectedPanel((current) => nextPanel(current));
      return;
    }

    if (input >= "1" && input <= String(PANEL_ORDER.length)) {
      const nextPanelId = PANEL_ORDER[Number(input) - 1];
      if (nextPanelId !== undefined) {
        controller.setSelectedPanel(nextPanelId);
      }
      return;
    }

    if (input === "r") {
      controller.refresh();
      return;
    }

    if (input === "]") {
      controller.setSelectedTaskIndex((current) =>
        Math.min(current + 1, Math.max(controller.snapshot.tasks.length - 1, 0))
      );
      return;
    }

    if (input === "[") {
      controller.setSelectedTaskIndex((current) => Math.max(current - 1, 0));
      return;
    }

    if (controller.selectedPanel === "approvals") {
      if (key.upArrow) {
        controller.setSelectedApprovalIndex((current) => Math.max(current - 1, 0));
        return;
      }

      if (key.downArrow) {
        controller.setSelectedApprovalIndex((current) =>
          Math.min(current + 1, Math.max(controller.snapshot.pendingApprovals.length - 1, 0))
        );
        return;
      }

      if (input === "a") {
        void controller.resolveSelectedApproval("allow");
        return;
      }

      if (input === "d") {
        void controller.resolveSelectedApproval("deny");
      }

      return;
    }

    if (key.upArrow) {
      controller.setSelectedTaskIndex((current) => Math.max(current - 1, 0));
      return;
    }

    if (key.downArrow) {
      controller.setSelectedTaskIndex((current) =>
        Math.min(current + 1, Math.max(controller.snapshot.tasks.length - 1, 0))
      );
    }
  });

  const selectedTask = controller.snapshot.selectedTask;

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text color="green">Tentaclaw Phase 4 TUI</Text>
        <Text color="gray">
          tasks={controller.snapshot.summary.taskCount} running={controller.snapshot.summary.runningTaskCount} approvals=
          {controller.snapshot.summary.pendingApprovalCount} failed=
          {controller.snapshot.summary.failedTaskCount}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Box width={42} flexDirection="column" marginRight={2}>
          <Text color="cyan">Tasks</Text>
          {controller.snapshot.tasks.length === 0 ? (
            <Text color="gray">No tasks persisted.</Text>
          ) : (
            controller.snapshot.tasks.map((task, index) => (
              <Text key={task.taskId} {...taskRowTextProps(index, controller.selectedTaskIndex, task.status)}>
                {index === controller.selectedTaskIndex ? ">" : " "} {task.status.padEnd(16, " ")} {task.currentStage.padEnd(12, " ")}
                {task.hasPendingApproval ? " [approval]" : ""} {task.title}
              </Text>
            ))
          )}
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          <PanelTabs selectedPanel={controller.selectedPanel} />
          <Box marginTop={1} flexDirection="column">
            {controller.selectedPanel === "tasks" ? (
              <TaskPanel selectedTask={selectedTask} />
            ) : controller.selectedPanel === "approvals" ? (
              <ApprovalPanel
                approvals={controller.snapshot.pendingApprovals}
                busy={controller.busy}
                selectedApprovalIndex={controller.selectedApprovalIndex}
              />
            ) : controller.selectedPanel === "diff" ? (
              <DiffPanel diff={selectedTask?.diff ?? []} />
            ) : controller.selectedPanel === "trace" ? (
              <TracePanel trace={selectedTask?.trace ?? []} />
            ) : controller.selectedPanel === "memory" ? (
              <MemoryPanel memoryHits={selectedTask?.memoryHits ?? []} />
            ) : (
              <ErrorsPanel errors={selectedTask?.errors ?? []} />
            )}
          </Box>
        </Box>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">{controller.statusLine}</Text>
        <Text color="gray">
          Help: 1-6 panels | tab shift panels | arrows browse | [ ] switch task from any panel | a/d decide approval | r refresh | q quit
        </Text>
      </Box>
    </Box>
  );
}

function PanelTabs({ selectedPanel }: { selectedPanel: TuiPanelId }): React.ReactElement {
  return (
    <Text>
      {PANEL_ORDER.map((panel, index) => (
        <Text key={panel} color={panel === selectedPanel ? "green" : "gray"}>
          {index + 1}.{panel}{" "}
        </Text>
      ))}
    </Text>
  );
}

function taskRowTextProps(
  index: number,
  selectedTaskIndex: number,
  status: string
): { color?: "green" | "red" } {
  if (index === selectedTaskIndex) {
    return { color: "green" };
  }

  if (status === "failed") {
    return { color: "red" };
  }

  return {};
}
