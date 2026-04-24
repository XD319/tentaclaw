import React from "react";
import { Box, Text, useApp, useInput } from "ink";

import { Banner } from "./components/banner.js";
import { StatusBar } from "./components/status-bar.js";
import { useDashboardController, nextPanel, previousPanel } from "./hooks/use-dashboard-controller.js";
import {
  ApprovalPanel,
  DiffPanel,
  ErrorsPanel,
  ExperiencePanel,
  MemoryPanel,
  SkillsPanel,
  TaskPanel,
  TracePanel
} from "./panels/index.js";
import { theme } from "./theme.js";
import {
  PANEL_ORDER,
  type RuntimeDashboardQueryService,
  type TuiPanelId
} from "./view-models/runtime-dashboard.js";

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
  const ctrlCRequestedAtRef = React.useRef<number | null>(null);
  const controller = useDashboardController({
    queryService,
    refreshIntervalMs,
    reviewerId
  });
  const stdoutWidth = process.stdout.columns ?? 120;
  const leftPaneWidth = clamp(Math.floor(stdoutWidth * 0.34), 30, 46);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      const now = Date.now();
      const lastRequestedAt = ctrlCRequestedAtRef.current;
      if (lastRequestedAt !== null && now - lastRequestedAt <= 2_000) {
        exit();
        return;
      }
      ctrlCRequestedAtRef.current = now;
      return;
    }

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

    const panelNumber = Number.parseInt(input, 10);
    if (Number.isInteger(panelNumber) && panelNumber >= 1 && panelNumber <= PANEL_ORDER.length) {
      const nextPanelId = PANEL_ORDER[panelNumber - 1];
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
      <Banner
        details={[
          `tasks ${controller.snapshot.summary.taskCount}`,
          `running ${controller.snapshot.summary.runningTaskCount}`,
          `approvals ${controller.snapshot.summary.pendingApprovalCount}`,
          `failed ${controller.snapshot.summary.failedTaskCount}`
        ]}
        meta={[`reviewer ${reviewerId}`, `refresh ${refreshIntervalMs}ms`]}
        productName="AUTOTALON"
        subtitle="Operational dashboard for governed runtime activity"
        title="Runtime Dashboard"
      />
      <Box marginTop={1}>
        <Box
          borderStyle="classic"
          borderColor={theme.border}
          width={leftPaneWidth}
          flexDirection="column"
          marginRight={1}
          paddingX={1}
        >
          <Text color={theme.panelTitle}>Tasks</Text>
          {controller.snapshot.tasks.length === 0 ? (
            <Text color={theme.muted}>No tasks persisted.</Text>
          ) : (
            controller.snapshot.tasks.map((task, index) => (
              <Box
                key={task.taskId}
                borderStyle="classic"
                borderColor={index === controller.selectedTaskIndex ? theme.selection : theme.border}
                flexDirection="column"
                marginBottom={1}
                paddingX={1}
              >
                <Text {...taskRowTextProps(index, controller.selectedTaskIndex, task.status)}>
                  {task.shortTaskId}  {task.statusLabel}
                  {task.hasPendingApproval ? "  [approval]" : ""}
                </Text>
                <Text color={theme.muted}>
                  {task.stageLabel}  |  updated {task.updatedLabel}
                </Text>
                <Text color={theme.fg} wrap="wrap">
                  {task.title}
                </Text>
              </Box>
            ))
          )}
        </Box>
        <Box borderStyle="classic" borderColor={theme.border} flexDirection="column" flexGrow={1} paddingX={1}>
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
            ) : controller.selectedPanel === "experience" ? (
              <ExperiencePanel experiences={selectedTask?.experienceHits ?? []} />
            ) : controller.selectedPanel === "skills" ? (
              <SkillsPanel skills={controller.snapshot.skills} />
            ) : (
              <ErrorsPanel errors={selectedTask?.errors ?? []} />
            )}
          </Box>
        </Box>
      </Box>
      <Box marginTop={1}>
        <StatusBar
          details={[
            `panel ${controller.selectedPanel}`,
            `task ${controller.uiStatus.taskLabel ?? "none"}`,
            `selected ${selectedTask === null ? "none" : selectedTask.finalSummary}`
          ]}
          hints={[
            `1-${PANEL_ORDER.length} panels | Tab switch | [ ] task`,
            "Arrows browse | a/d approval | r refresh | q quit"
          ]}
          metrics={[
            { label: `running ${controller.snapshot.summary.runningTaskCount}`, tone: "accent" },
            { label: `approvals ${controller.snapshot.summary.pendingApprovalCount}`, tone: "warn" },
            { label: `failed ${controller.snapshot.summary.failedTaskCount}`, tone: "danger" }
          ]}
          primary={{
            label: controller.uiStatus.primaryLabel,
            tone: controller.uiStatus.primaryTone
          }}
        />
      </Box>
    </Box>
  );
}

function PanelTabs({ selectedPanel }: { selectedPanel: TuiPanelId }): React.ReactElement {
  return (
    <Text wrap="wrap">
      {PANEL_ORDER.map((panel, index) => (
        <Text key={panel} color={panel === selectedPanel ? theme.selection : theme.muted}>
          {`${index + 1}.${panel}${panel === selectedPanel ? " [selected]" : ""} `}
        </Text>
      ))}
    </Text>
  );
}

function taskRowTextProps(
  index: number,
  selectedTaskIndex: number,
  status: string
): { color?: string } {
  if (index === selectedTaskIndex) {
    return { color: theme.selection };
  }

  if (status === "failed") {
    return { color: theme.danger };
  }

  return { color: theme.fg };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
