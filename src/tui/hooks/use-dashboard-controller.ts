import React from "react";

import {
  PANEL_ORDER,
  type ApprovalListItemViewModel,
  type RuntimeDashboardQueryService,
  type RuntimeDashboardViewModel,
  type TuiPanelId
} from "../view-models/runtime-dashboard.js";
import type { UiStatus } from "../ui-status.js";

export interface DashboardController {
  busy: boolean;
  refresh: () => void;
  resolveSelectedApproval: (action: "allow" | "deny") => Promise<void>;
  selectedApproval: ApprovalListItemViewModel | null;
  selectedApprovalIndex: number;
  selectedPanel: TuiPanelId;
  selectedTaskIndex: number;
  setSelectedApprovalIndex: React.Dispatch<React.SetStateAction<number>>;
  setSelectedPanel: React.Dispatch<React.SetStateAction<TuiPanelId>>;
  setSelectedTaskIndex: React.Dispatch<React.SetStateAction<number>>;
  snapshot: RuntimeDashboardViewModel;
  statusLine: string;
  uiStatus: UiStatus;
}

export function useDashboardController(input: {
  queryService: RuntimeDashboardQueryService;
  refreshIntervalMs: number;
  reviewerId: string;
}): DashboardController {
  const [selectedPanel, setSelectedPanel] = React.useState<TuiPanelId>("tasks");
  const [selectedTaskIndex, setSelectedTaskIndex] = React.useState(0);
  const [selectedApprovalIndex, setSelectedApprovalIndex] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [statusLine, setStatusLine] = React.useState(
    `Keys: 1-${PANEL_ORDER.length} panels, tab switch, arrows browse, a allow, d deny, r refresh, q quit`
  );
  const [uiStatus, setUiStatus] = React.useState<UiStatus>({
    approvalLabel: null,
    primaryLabel: "dashboard ready",
    primaryTone: "muted",
    runState: "idle",
    taskLabel: null
  });
  const [snapshot, setSnapshot] = React.useState(() =>
    input.queryService.getDashboard({
      selectedPanel,
      selectedTaskId: null
    })
  );

  React.useEffect(() => {
    const runRefresh = (): void => {
      try {
        setSnapshot((previousSnapshot) => {
          const currentTaskId =
            previousSnapshot.tasks[selectedTaskIndex]?.taskId ?? previousSnapshot.selectedTaskId ?? null;
          const nextSnapshot = input.queryService.getDashboard({
            selectedPanel,
            selectedTaskId: currentTaskId
          });
          setSelectedTaskIndex((currentIndex) => clampIndex(currentIndex, nextSnapshot.tasks.length));
          setSelectedApprovalIndex((currentIndex) =>
            clampIndex(currentIndex, nextSnapshot.pendingApprovals.length)
          );
          updateUiStatus(setUiStatus, buildDashboardUiStatus(nextSnapshot, selectedPanel));
          return dashboardSnapshotEquals(previousSnapshot, nextSnapshot) ? previousSnapshot : nextSnapshot;
        });
      } catch (error) {
        setStatusLine(error instanceof Error ? `Refresh failed: ${error.message}` : "Refresh failed.");
        setUiStatus({
          approvalLabel: null,
          primaryLabel: "refresh failed",
          primaryTone: "danger",
          runState: "failed",
          taskLabel: null
        });
      }
    };

    runRefresh();
    const interval = setInterval(runRefresh, input.refreshIntervalMs);

    return () => {
      clearInterval(interval);
    };
  }, [input.queryService, input.refreshIntervalMs, selectedPanel, selectedTaskIndex]);

  const refresh = (): void => {
    try {
      const currentTaskId = snapshot.tasks[selectedTaskIndex]?.taskId ?? snapshot.selectedTaskId ?? null;
      const nextSnapshot = input.queryService.getDashboard({
        selectedPanel,
        selectedTaskId: currentTaskId
      });
      setSnapshot(nextSnapshot);
      setSelectedTaskIndex((currentIndex) => clampIndex(currentIndex, nextSnapshot.tasks.length));
      setSelectedApprovalIndex((currentIndex) =>
        clampIndex(currentIndex, nextSnapshot.pendingApprovals.length)
      );
      setStatusLine(`Refreshed at ${new Date().toLocaleTimeString("en-GB", { hour12: false })}`);
      setUiStatus(buildDashboardUiStatus(nextSnapshot, selectedPanel));
    } catch (error) {
      setStatusLine(error instanceof Error ? `Refresh failed: ${error.message}` : "Refresh failed.");
      setUiStatus({
        approvalLabel: null,
        primaryLabel: "refresh failed",
        primaryTone: "danger",
        runState: "failed",
        taskLabel: null
      });
    }
  };

  const selectedApproval = snapshot.pendingApprovals[selectedApprovalIndex] ?? null;

  const resolveSelectedApproval = async (action: "allow" | "deny"): Promise<void> => {
    if (selectedApproval === null || busy) {
      return;
    }

    setBusy(true);
    try {
      const result = await input.queryService.resolveApproval(
        selectedApproval.approvalId,
        action,
        input.reviewerId
      );
      const nextSnapshot = input.queryService.getDashboard({
        selectedPanel,
        selectedTaskId: result.task.taskId
      });

      setSnapshot(nextSnapshot);
      setSelectedTaskIndex(
        Math.max(0, nextSnapshot.tasks.findIndex((task) => task.taskId === result.task.taskId))
      );
      setSelectedApprovalIndex(clampIndex(selectedApprovalIndex, nextSnapshot.pendingApprovals.length));
      setStatusLine(
        result.error === undefined
          ? `${action === "allow" ? "Approved" : "Denied"} ${selectedApproval.toolName} for ${result.task.taskId.slice(0, 8)}`
          : `Approved ${selectedApproval.toolName}, then task failed: ${result.error.code}`
      );
      setUiStatus({
        approvalLabel: selectedApproval.toolName,
        primaryLabel:
          result.error === undefined
            ? `${action === "allow" ? "approved" : "denied"} ${selectedApproval.toolName}`
            : `approval completed, task failed`,
        primaryTone: result.error === undefined ? (action === "allow" ? "success" : "warn") : "danger",
        runState: result.error === undefined ? "succeeded" : "failed",
        taskLabel: result.task.taskId.slice(0, 8)
      });
    } catch (error) {
      setStatusLine(
        error instanceof Error ? `Approval action failed: ${error.message}` : "Approval action failed."
      );
      setUiStatus({
        approvalLabel: selectedApproval.toolName,
        primaryLabel: "approval action failed",
        primaryTone: "danger",
        runState: "failed",
        taskLabel: selectedApproval.taskId.slice(0, 8)
      });
    } finally {
      setBusy(false);
    }
  };

  return {
    busy,
    refresh,
    resolveSelectedApproval,
    selectedApproval,
    selectedApprovalIndex,
    selectedPanel,
    selectedTaskIndex,
    setSelectedApprovalIndex,
    setSelectedPanel,
    setSelectedTaskIndex,
    snapshot,
    statusLine,
    uiStatus
  };
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }

  return Math.min(Math.max(index, 0), length - 1);
}

export function nextPanel(current: TuiPanelId): TuiPanelId {
  const currentIndex = PANEL_ORDER.indexOf(current);
  return PANEL_ORDER[(currentIndex + 1) % PANEL_ORDER.length] ?? "tasks";
}

export function previousPanel(current: TuiPanelId): TuiPanelId {
  const currentIndex = PANEL_ORDER.indexOf(current);
  return PANEL_ORDER[(currentIndex - 1 + PANEL_ORDER.length) % PANEL_ORDER.length] ?? "tasks";
}

function buildDashboardUiStatus(snapshot: RuntimeDashboardViewModel, selectedPanel: TuiPanelId): UiStatus {
  if (snapshot.pendingApprovals.length > 0) {
    return {
      approvalLabel: snapshot.pendingApprovals[0]?.toolName ?? null,
      primaryLabel: `approval queue: ${snapshot.pendingApprovals.length}`,
      primaryTone: "warn",
      runState: "waiting_approval",
      taskLabel: snapshot.selectedTaskId?.slice(0, 8) ?? null
    };
  }

  if (snapshot.summary.failedTaskCount > 0) {
    return {
      approvalLabel: null,
      primaryLabel: `review failures in ${selectedPanel}`,
      primaryTone: "danger",
      runState: "failed",
      taskLabel: snapshot.selectedTaskId?.slice(0, 8) ?? null
    };
  }

  if (snapshot.summary.runningTaskCount > 0) {
    return {
      approvalLabel: null,
      primaryLabel: `watching ${snapshot.summary.runningTaskCount} running task(s)`,
      primaryTone: "accent",
      runState: "running",
      taskLabel: snapshot.selectedTaskId?.slice(0, 8) ?? null
    };
  }

  return {
    approvalLabel: null,
    primaryLabel: `panel ${selectedPanel}`,
    primaryTone: "muted",
    runState: "idle",
    taskLabel: snapshot.selectedTaskId?.slice(0, 8) ?? null
  };
}

function dashboardSnapshotEquals(
  left: RuntimeDashboardViewModel,
  right: RuntimeDashboardViewModel
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function updateUiStatus(
  setUiStatus: React.Dispatch<React.SetStateAction<UiStatus>>,
  next: UiStatus
): void {
  setUiStatus((current) => (uiStatusEquals(current, next) ? current : next));
}

function uiStatusEquals(left: UiStatus, right: UiStatus): boolean {
  return (
    left.approvalLabel === right.approvalLabel &&
    left.primaryLabel === right.primaryLabel &&
    left.primaryTone === right.primaryTone &&
    left.runState === right.runState &&
    left.taskLabel === right.taskLabel
  );
}
