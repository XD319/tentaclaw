import type { AgentApplicationService } from "../../runtime";
import type { ApprovalActionResult } from "../../runtime/application-service";
import type {
  ApprovalRecord,
  ArtifactRecord,
  ExperienceRecord,
  JsonObject,
  JsonValue,
  MemoryRecord,
  TaskRecord,
  TraceEvent,
  ToolCallRecord
} from "../../types";

export const PANEL_ORDER = [
  "tasks",
  "approvals",
  "diff",
  "trace",
  "memory",
  "experience",
  "errors"
] as const;

export type TuiPanelId = (typeof PANEL_ORDER)[number];

export interface DashboardSummaryViewModel {
  failedTaskCount: number;
  pendingApprovalCount: number;
  runningTaskCount: number;
  succeededTaskCount: number;
  taskCount: number;
}

export interface TaskListItemViewModel {
  currentStage: string;
  failureBadge: string | null;
  finalSummary: string;
  hasPendingApproval: boolean;
  status: TaskRecord["status"];
  taskId: string;
  title: string;
  updatedAt: string;
}

export interface ApprovalListItemViewModel {
  approvalId: string;
  expiresAt: string;
  reason: string;
  riskLevel: ToolCallRecord["riskLevel"] | "unknown";
  status: ApprovalRecord["status"];
  taskId: string;
  taskLabel: string;
  toolName: string;
}

export interface DiffViewModel {
  afterPreview: string;
  artifactId: string;
  beforePreview: string;
  changedLineCount: number;
  operation: string;
  path: string;
  removedLineCount: number;
  riskHighlight: boolean;
  riskReasons: string[];
  summary: string;
  unifiedDiff: string;
}

export interface TraceEntryViewModel {
  actor: string;
  chainLabel: string | null;
  emphasis: "default" | "error" | "muted" | "warning";
  eventType: TraceEvent["eventType"];
  iteration: number | null;
  sequence: number;
  stage: TraceEvent["stage"];
  summary: string;
  timestamp: string;
}

export interface MemoryHitViewModel {
  confidence: number;
  downgraded: boolean;
  reasons: string[];
  scope: MemoryRecord["scope"];
  selected: boolean;
  source: string;
  status: MemoryRecord["status"];
  title: string;
  memoryId: string;
}

export interface ExperienceHitViewModel {
  confidence: number;
  experienceId: string;
  matchScore: number | null;
  provenance: string;
  promotionTarget: string;
  sourceType: ExperienceRecord["sourceType"];
  status: ExperienceRecord["status"];
  title: string;
  type: ExperienceRecord["type"];
  valueScore: number;
}

export interface ErrorViewModel {
  code: string;
  message: string;
  source: string;
  timestamp: string;
}

export interface SelectedTaskViewModel {
  approvals: ApprovalListItemViewModel[];
  diff: DiffViewModel[];
  errors: ErrorViewModel[];
  experienceHits: ExperienceHitViewModel[];
  finalSummary: string;
  memoryHits: MemoryHitViewModel[];
  metadata: Array<{ label: string; value: string }>;
  recentEvents: string[];
  trace: TraceEntryViewModel[];
}

export interface RuntimeDashboardViewModel {
  generatedAt: string;
  pendingApprovals: ApprovalListItemViewModel[];
  selectedPanel: TuiPanelId;
  selectedTask: SelectedTaskViewModel | null;
  selectedTaskId: string | null;
  summary: DashboardSummaryViewModel;
  tasks: TaskListItemViewModel[];
}

export interface RuntimeDashboardQueryOptions {
  selectedPanel: TuiPanelId;
  selectedTaskId: string | null;
}

export class RuntimeDashboardQueryService {
  public constructor(private readonly service: AgentApplicationService) {}

  public async resolveApproval(
    approvalId: string,
    action: "allow" | "deny",
    reviewerId: string
  ): Promise<ApprovalActionResult> {
    return this.service.resolveApproval(approvalId, action, reviewerId);
  }

  public getDashboard(options: RuntimeDashboardQueryOptions): RuntimeDashboardViewModel {
    const tasks = this.service.listTasks();
    const pendingApprovals = this.service.listPendingApprovals();
    const selectedTaskId = selectTaskId(tasks, pendingApprovals, options.selectedTaskId);
    const selectedTask = selectedTaskId === null ? null : this.buildSelectedTask(selectedTaskId);

    return {
      generatedAt: new Date().toISOString(),
      pendingApprovals: pendingApprovals.map((approval) => toApprovalItem(approval, tasks, this.service)),
      selectedPanel: options.selectedPanel,
      selectedTask,
      selectedTaskId,
      summary: {
        failedTaskCount: tasks.filter((task) => task.status === "failed").length,
        pendingApprovalCount: pendingApprovals.length,
        runningTaskCount: tasks.filter((task) => task.status === "running").length,
        succeededTaskCount: tasks.filter((task) => task.status === "succeeded").length,
        taskCount: tasks.length
      },
      tasks: tasks.map((task) => toTaskListItem(task, this.service.showTask(task.taskId)))
    };
  }

  private buildSelectedTask(taskId: string): SelectedTaskViewModel | null {
    const detail = this.service.showTask(taskId);
    if (detail.task === null) {
      return null;
    }

    const memories = this.service.listMemories();
    const experiences = this.service.listExperiences({
      taskId
    });
    const currentTask = detail.task;

    return {
      approvals: detail.approvals.map((approval) => toApprovalItem(approval, [currentTask], this.service)),
      diff: buildDiffViewModels(detail.artifacts),
      errors: buildErrorViewModels(currentTask, detail.trace),
      experienceHits: buildExperienceHits(experiences, detail.trace),
      finalSummary: summarizeTask(currentTask),
      memoryHits: buildMemoryHits(detail.trace, memories),
      metadata: buildMetadata(currentTask),
      recentEvents: detail.trace.slice(-5).map((event) => event.summary),
      trace: detail.trace.slice(-30).map(toTraceEntry)
    };
  }
}

function selectTaskId(
  tasks: TaskRecord[],
  approvals: ApprovalRecord[],
  currentTaskId: string | null
): string | null {
  if (currentTaskId !== null && tasks.some((task) => task.taskId === currentTaskId)) {
    return currentTaskId;
  }

  const pendingApprovalTaskId = approvals[0]?.taskId;
  if (pendingApprovalTaskId !== undefined) {
    return pendingApprovalTaskId;
  }

  const failedTaskId = tasks.find((task) => task.status === "failed")?.taskId;
  if (failedTaskId !== undefined) {
    return failedTaskId;
  }

  return tasks[0]?.taskId ?? null;
}

function toTaskListItem(
  task: TaskRecord,
  detail: ReturnType<AgentApplicationService["showTask"]>
): TaskListItemViewModel {
  const lastStage = detail.trace.at(-1)?.stage ?? "lifecycle";
  const hasPendingApproval = detail.approvals.some((approval) => approval.status === "pending");

  return {
    currentStage: task.status === "waiting_approval" ? "governance" : lastStage,
    failureBadge:
      task.status === "failed"
        ? task.errorCode ?? "failed"
        : hasPendingApproval
          ? "approval"
          : null,
    finalSummary: summarizeTask(task),
    hasPendingApproval,
    status: task.status,
    taskId: task.taskId,
    title: summarizeText(task.input, 56),
    updatedAt: task.updatedAt
  };
}

function toApprovalItem(
  approval: ApprovalRecord,
  tasks: TaskRecord[],
  service: AgentApplicationService
): ApprovalListItemViewModel {
  const detail = service.showTask(approval.taskId);
  const task = tasks.find((item) => item.taskId === approval.taskId) ?? detail.task;
  const toolCall = detail.toolCalls.find((item) => item.toolCallId === approval.toolCallId);

  return {
    approvalId: approval.approvalId,
    expiresAt: approval.expiresAt,
    reason: approval.reason,
    riskLevel: toolCall?.riskLevel ?? "unknown",
    status: approval.status,
    taskId: approval.taskId,
    taskLabel: task === null ? approval.taskId : summarizeText(task.input, 40),
    toolName: approval.toolName
  };
}

function buildDiffViewModels(artifacts: ArtifactRecord[]): DiffViewModel[] {
  return artifacts
    .filter((artifact) => artifact.artifactType === "file")
    .map((artifact) => toDiffViewModel(artifact))
    .filter((entry): entry is DiffViewModel => entry !== null);
}

function toDiffViewModel(artifact: ArtifactRecord): DiffViewModel | null {
  if (!isJsonObject(artifact.content)) {
    return null;
  }

  const path = readString(artifact.content.path);
  const operation = readString(artifact.content.operation);
  if (path === null || operation === null) {
    return null;
  }

  const beforePreview = readString(artifact.content.beforeText) ?? "";
  const afterPreview = readString(artifact.content.afterText) ?? "";
  const diffSummary = isJsonObject(artifact.content.diffSummary) ? artifact.content.diffSummary : {};
  const changedLineCount = readNumber(diffSummary.changedLineCount) ?? 0;
  const removedLineCount = readNumber(diffSummary.removedLineCount) ?? 0;
  const riskReasons = collectDiffRiskReasons(path, beforePreview, afterPreview, changedLineCount);
  const unifiedDiff = readString(artifact.content.unifiedDiff) ?? "";

  return {
    artifactId: artifact.artifactId,
    afterPreview: afterPreview === "" ? "(empty)" : afterPreview,
    beforePreview: beforePreview === "" ? "(new file)" : beforePreview,
    changedLineCount,
    operation,
    path,
    removedLineCount,
    riskHighlight: riskReasons.length > 0,
    riskReasons,
    summary: `${operation} | changed=${changedLineCount} removed=${removedLineCount}`,
    unifiedDiff
  };
}

function buildExperienceHits(
  experiences: ExperienceRecord[],
  trace: TraceEvent[]
): ExperienceHitViewModel[] {
  const recallEvent = [...trace]
    .reverse()
    .find(
      (event): event is Extract<TraceEvent, { eventType: "experience_recall_ranked" }> =>
        event.eventType === "experience_recall_ranked"
    );
  const scores = new Map(
    recallEvent?.payload.entries.map((entry) => [entry.experienceId, entry.finalScore]) ?? []
  );

  return experiences.slice(0, 10).map((experience) => ({
    confidence: experience.confidence,
    experienceId: experience.experienceId,
    matchScore: scores.get(experience.experienceId) ?? null,
    promotionTarget: experience.promotionTarget ?? "-",
    provenance: `${experience.provenance.sourceLabel} task=${experience.provenance.taskId ?? "-"} reviewer=${experience.provenance.reviewerId ?? "-"}`,
    sourceType: experience.sourceType,
    status: experience.status,
    title: experience.title,
    type: experience.type,
    valueScore: experience.valueScore
  }));
}

function toTraceEntry(event: TraceEvent): TraceEntryViewModel {
  return {
    actor: event.actor,
    chainLabel: extractChainLabel(event),
    emphasis:
      event.eventType === "tool_call_failed" || event.eventType === "final_outcome"
        ? isFinalFailure(event)
          ? "error"
          : "default"
        : event.eventType === "retry"
          ? "warning"
          : event.eventType === "memory_recalled"
            ? "muted"
            : "default",
    eventType: event.eventType,
    iteration: extractIteration(event),
    sequence: event.sequence,
    stage: event.stage,
    summary: event.summary,
    timestamp: event.timestamp
  };
}

function extractIteration(event: TraceEvent): number | null {
  const payload = event.payload as { iteration?: unknown };
  return typeof payload.iteration === "number" ? payload.iteration : null;
}

function buildMemoryHits(trace: TraceEvent[], memories: MemoryRecord[]): MemoryHitViewModel[] {
  const recallEvent = [...trace]
    .reverse()
    .find((event): event is Extract<TraceEvent, { eventType: "memory_recalled" }> => event.eventType === "memory_recalled");

  if (recallEvent === undefined) {
    return [];
  }

  const selectedIds = new Set(recallEvent.payload.selectedMemoryIds);
  const blockedIds = new Set(recallEvent.payload.blockedMemoryIds);
  const relevantIds = [...new Set([...selectedIds, ...blockedIds])];

  return relevantIds
    .map((memoryId) => memories.find((memory) => memory.memoryId === memoryId))
    .filter((memory): memory is MemoryRecord => memory !== undefined)
    .map((memory) => {
      const reasons: string[] = [];
      const selected = selectedIds.has(memory.memoryId);
      const blocked = blockedIds.has(memory.memoryId);
      const downgraded =
        memory.status === "stale" || memory.status === "candidate" || memory.confidence < 0.75;

      if (blocked) {
        reasons.push("filtered by context policy");
      }
      if (memory.status === "stale") {
        reasons.push("downgraded because memory is stale");
      }
      if (memory.status === "candidate") {
        reasons.push("downgraded because memory is unverified");
      }
      if (memory.confidence < 0.75) {
        reasons.push(`downgraded for confidence ${memory.confidence.toFixed(2)}`);
      }
      if (selected) {
        reasons.push("included in active model context");
      }

      return {
        confidence: memory.confidence,
        downgraded,
        memoryId: memory.memoryId,
        reasons,
        scope: memory.scope,
        selected,
        source: memory.source.label,
        status: memory.status,
        title: memory.title
      };
    });
}

function buildErrorViewModels(task: TaskRecord, trace: TraceEvent[]): ErrorViewModel[] {
  const errors: ErrorViewModel[] = [];

  if (task.errorCode !== null || task.errorMessage !== null) {
    errors.push({
      code: task.errorCode ?? task.status,
      message: task.errorMessage ?? summarizeTask(task),
      source: "task",
      timestamp: task.updatedAt
    });
  }

  for (const event of trace) {
    if (event.eventType === "retry") {
      errors.push({
        code: "retry",
        message: event.payload.reason,
        source: "runtime.retry",
        timestamp: event.timestamp
      });
    }

    if (event.eventType === "interrupt") {
      errors.push({
        code: "interrupt",
        message: event.payload.reason,
        source: "runtime.interrupt",
        timestamp: event.timestamp
      });
    }

    if (event.eventType === "tool_call_failed") {
      errors.push({
        code: event.payload.errorCode,
        message: event.payload.errorMessage,
        source: `tool.${event.payload.toolName}`,
        timestamp: event.timestamp
      });
    }

    if (event.eventType === "sandbox_enforced" && event.payload.status === "denied") {
      errors.push({
        code: "sandbox_reject",
        message: `${event.payload.toolName} denied for ${event.payload.target}`,
        source: "sandbox",
        timestamp: event.timestamp
      });
    }

    if (event.eventType === "approval_resolved" && event.payload.status !== "approved") {
      errors.push({
        code: event.payload.status,
        message: `${event.payload.toolName} ${event.payload.status}`,
        source: "approval",
        timestamp: event.timestamp
      });
    }

    if (event.eventType === "policy_decision" && event.payload.effect === "deny") {
      errors.push({
        code: "policy_denied",
        message: `${event.payload.toolName} denied by policy ${event.payload.matchedRuleId ?? "unknown"}`,
        source: "policy",
        timestamp: event.timestamp
      });
    }
  }

  return errors.slice(-8).reverse();
}

function buildMetadata(task: TaskRecord): Array<{ label: string; value: string }> {
  return [
    { label: "Task", value: task.taskId },
    { label: "Profile", value: task.agentProfileId },
    { label: "Requester", value: task.requesterUserId },
    { label: "CWD", value: task.cwd },
    { label: "Iterations", value: `${task.currentIteration}/${task.maxIterations}` },
    { label: "Created", value: task.createdAt },
    { label: "Updated", value: task.updatedAt },
    { label: "Provider", value: task.providerName }
  ];
}

function summarizeTask(task: TaskRecord): string {
  if (task.finalOutput !== null) {
    return summarizeText(task.finalOutput, 84);
  }

  if (task.errorMessage !== null) {
    return summarizeText(task.errorMessage, 84);
  }

  if (task.status === "waiting_approval") {
    return "waiting for reviewer approval";
  }

  return summarizeText(task.input, 84);
}

function collectDiffRiskReasons(
  path: string,
  beforePreview: string,
  afterPreview: string,
  changedLineCount: number
): string[] {
  const reasons: string[] = [];
  const lowerPath = path.toLowerCase();
  const normalizedPath = lowerPath.replace(/\\/gu, "/");
  const combinedPreview = `${beforePreview}\n${afterPreview}`.toLowerCase();

  if (
    lowerPath.endsWith("package.json") ||
    lowerPath.endsWith("pnpm-lock.yaml") ||
    lowerPath.includes(".env") ||
    lowerPath.endsWith(".ps1") ||
    lowerPath.endsWith(".sh")
  ) {
    reasons.push("sensitive project or execution file");
  }

  if (normalizedPath.includes("/src/policy/") || normalizedPath.includes("/src/runtime/")) {
    reasons.push("runtime or policy surface changed");
  }

  if (changedLineCount >= 40) {
    reasons.push("large change set");
  }

  if (
    combinedPreview.includes("remove-item") ||
    combinedPreview.includes("rm -rf") ||
    combinedPreview.includes("child_process") ||
    combinedPreview.includes("invoke-expression")
  ) {
    reasons.push("contains high-risk execution keywords");
  }

  return reasons;
}

function extractChainLabel(event: TraceEvent): string | null {
  switch (event.eventType) {
    case "approval_requested":
    case "approval_resolved":
    case "sandbox_enforced":
    case "tool_call_requested":
    case "tool_call_started":
    case "tool_call_finished":
    case "tool_call_failed":
      return `${event.payload.toolName}#${event.payload.toolCallId.slice(0, 8)}`;
    default:
      return null;
  }
}

function isFinalFailure(event: TraceEvent): boolean {
  return event.eventType === "final_outcome" && event.payload.status !== "succeeded";
}

function summarizeText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength)}...`;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: JsonValue | undefined): number | null {
  return typeof value === "number" ? value : null;
}
