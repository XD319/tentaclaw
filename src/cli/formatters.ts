import type { AgentDoctorReport, ContextTraceDebugReport, TaskTimelineReport } from "../runtime/index.js";
import type { BetaReadinessReport, EvalReport, ReplayRunResult, ReleaseChecklistReport } from "../diagnostics/index.js";
import type {
  ApprovalRecord,
  AuditLogRecord,
  CommitmentRecord,
  ExperienceRecord,
  InboxItem,
  MemoryRecord,
  MemorySnapshotRecord,
  NextActionRecord,
  ProviderStatsSnapshot,
  ScheduleRecord,
  ScheduleRunRecord,
  SkillDraftRecord,
  SkillListResult,
  SkillView,
  TaskRecord,
  ThreadLineageRecord,
  ThreadRecord,
  ThreadRunRecord,
  ThreadCommitmentState,
  ThreadSnapshotRecord,
  TraceEvent,
  ToolCallRecord
} from "../types/index.js";
import type { ExperienceRecallCandidate } from "../recall/recall-engine.js";

import { formatTraceEvent } from "../tracing/trace-formatter.js";

export function formatTaskList(tasks: TaskRecord[]): string {
  if (tasks.length === 0) {
    return "No tasks found.";
  }

  return tasks
    .map(
      (task) =>
        `${task.taskId} | ${task.status} | iter=${task.currentIteration}/${task.maxIterations} | ${task.input}`
    )
    .join("\n");
}

export function formatThreadList(threads: ThreadRecord[]): string {
  if (threads.length === 0) {
    return "No threads found.";
  }
  return threads
    .map(
      (thread) =>
        `${thread.threadId} | ${thread.status} | owner=${thread.ownerUserId} | updated=${thread.updatedAt} | ${thread.title}`
    )
    .join("\n");
}

export function formatThreadDetail(
  thread: ThreadRecord,
  runs: ThreadRunRecord[],
  lineage: ThreadLineageRecord[] = [],
  inboxItems: InboxItem[] = [],
  commitments: CommitmentRecord[] = [],
  nextActions: NextActionRecord[] = [],
  state?: ThreadCommitmentState
): string {
  const header = [
    `Thread ID: ${thread.threadId}`,
    `Title: ${thread.title}`,
    `Status: ${thread.status}`,
    `Owner: ${thread.ownerUserId}`,
    `Profile: ${thread.agentProfileId}`,
    `Provider: ${thread.providerName}`,
    `CWD: ${thread.cwd}`,
    `Created: ${thread.createdAt}`,
    `Updated: ${thread.updatedAt}`,
    `Archived: ${thread.archivedAt ?? "-"}`
  ].join("\n");
  const runsSection =
    runs.length === 0
      ? "Runs: none"
      : ["Runs:", ...runs.map((run) => `- #${run.runNumber} ${run.taskId} ${run.status} ${run.input}`)].join(
          "\n"
        );
  const lineageSection =
    lineage.length === 0
      ? "Lineage: none"
      : ["Lineage:", ...lineage.map((entry) => `- ${entry.createdAt} ${entry.eventType}`)].join("\n");
  const inboxSection =
    inboxItems.length === 0
      ? "Inbox Items: none"
      : ["Inbox Items:", ...inboxItems.map((item) => `- ${item.inboxId} ${item.status} ${item.title}`)].join(
          "\n"
        );
  const commitmentSection = formatCommitmentList(commitments);
  const nextActionSection = formatNextActionList(nextActions);
  const stateSection =
    state === undefined
      ? "Thread State: unavailable"
      : [
          "Thread State:",
          `- Current objective: ${state.currentObjective?.title ?? "-"}`,
          `- Next action: ${state.nextAction?.title ?? "-"}`,
          `- Blocked reason: ${state.blockedReason ?? "-"}`,
          `- Pending decision: ${state.pendingDecision ?? "-"}`
        ].join("\n");
  return `${header}\n${stateSection}\n${runsSection}\n${lineageSection}\n${commitmentSection}\n${nextActionSection}\n${inboxSection}`;
}

export function formatCommitmentList(commitments: CommitmentRecord[]): string {
  if (commitments.length === 0) {
    return "Commitments: none";
  }
  return [
    "Commitments:",
    ...commitments.map(
      (item) =>
        `- ${item.commitmentId} ${item.status} title=${item.title} blocked=${item.blockedReason ?? "-"}`
    )
  ].join("\n");
}

export function formatCommitmentDetail(item: CommitmentRecord): string {
  return [
    `Commitment ID: ${item.commitmentId}`,
    `Thread ID: ${item.threadId}`,
    `Task ID: ${item.taskId ?? "-"}`,
    `Owner: ${item.ownerUserId}`,
    `Status: ${item.status}`,
    `Title: ${item.title}`,
    `Summary: ${item.summary}`,
    `Blocked Reason: ${item.blockedReason ?? "-"}`,
    `Pending Decision: ${item.pendingDecision ?? "-"}`,
    `Source: ${item.source}`,
    `Due At: ${item.dueAt ?? "-"}`,
    `Created: ${item.createdAt}`,
    `Updated: ${item.updatedAt}`,
    `Completed: ${item.completedAt ?? "-"}`
  ].join("\n");
}

export function formatNextActionList(actions: NextActionRecord[]): string {
  if (actions.length === 0) {
    return "Next Actions: none";
  }
  return [
    "Next Actions:",
    ...actions.map(
      (item) =>
        `- ${item.nextActionId} rank=${item.rank} ${item.status} title=${item.title} blocked=${item.blockedReason ?? "-"}`
    )
  ].join("\n");
}

export function formatThreadSnapshotList(snapshots: ThreadSnapshotRecord[]): string {
  if (snapshots.length === 0) {
    return "No thread snapshots found.";
  }
  return snapshots
    .map(
      (snapshot) =>
        `${snapshot.snapshotId} | ${snapshot.trigger} | ${snapshot.createdAt} | goal=${snapshot.goal.slice(0, 80)}`
    )
    .join("\n");
}

export function formatThreadSnapshot(snapshot: ThreadSnapshotRecord): string {
  return [
    `Snapshot ID: ${snapshot.snapshotId}`,
    `Thread ID: ${snapshot.threadId}`,
    `Run ID: ${snapshot.runId ?? "-"}`,
    `Task ID: ${snapshot.taskId ?? "-"}`,
    `Trigger: ${snapshot.trigger}`,
    `Created At: ${snapshot.createdAt}`,
    `Goal: ${snapshot.goal}`,
    `Open Loops: ${snapshot.openLoops.join(", ") || "-"}`,
    `Blocked: ${snapshot.blockedReason ?? "-"}`,
    `Next Actions: ${snapshot.nextActions.join(", ") || "-"}`,
    `Active Memory IDs: ${snapshot.activeMemoryIds.join(", ") || "-"}`,
    `Tool Capabilities: ${snapshot.toolCapabilitySummary.join(", ") || "-"}`,
    `Summary: ${snapshot.summary}`
  ].join("\n");
}

export function formatScheduleList(schedules: ScheduleRecord[]): string {
  if (schedules.length === 0) {
    return "No schedules found.";
  }
  return schedules
    .map(
      (schedule) =>
        `${schedule.scheduleId} | ${schedule.status} | next=${schedule.nextFireAt ?? "-"} | ${schedule.name}`
    )
    .join("\n");
}

export function formatScheduleDetail(schedule: ScheduleRecord): string {
  return [
    `Schedule ID: ${schedule.scheduleId}`,
    `Name: ${schedule.name}`,
    `Status: ${schedule.status}`,
    `Thread ID: ${schedule.threadId ?? "-"}`,
    `Owner: ${schedule.ownerUserId}`,
    `Profile: ${schedule.agentProfileId}`,
    `Provider: ${schedule.providerName}`,
    `CWD: ${schedule.cwd}`,
    `Input: ${schedule.input}`,
    `Run At: ${schedule.runAt ?? "-"}`,
    `Interval (ms): ${schedule.intervalMs ?? "-"}`,
    `Cron: ${schedule.cron ?? "-"}`,
    `Timezone: ${schedule.timezone ?? "-"}`,
    `Next Fire: ${schedule.nextFireAt ?? "-"}`,
    `Last Fire: ${schedule.lastFireAt ?? "-"}`,
    `Max Attempts: ${schedule.maxAttempts}`,
    `Backoff Base (ms): ${schedule.backoffBaseMs}`,
    `Backoff Max (ms): ${schedule.backoffMaxMs}`
  ].join("\n");
}

export function formatScheduleRunList(runs: ScheduleRunRecord[]): string {
  if (runs.length === 0) {
    return "No schedule runs found.";
  }
  return runs
    .map(
      (run) =>
        `${run.runId} | attempt=${run.attemptNumber} | ${run.status} | trigger=${run.trigger} | task=${run.taskId ?? "-"} | thread=${run.threadId ?? "-"}`
    )
    .join("\n");
}

export function formatTask(
  task: TaskRecord,
  toolCalls: ToolCallRecord[],
  approvals: ApprovalRecord[] = [],
  scheduleRuns: ScheduleRunRecord[] = [],
  inboxItems: InboxItem[] = []
): string {
  const header = [
    `Task ID: ${task.taskId}`,
    `Status: ${task.status}`,
    `Input: ${task.input}`,
    `Provider: ${task.providerName}`,
    `Profile: ${task.agentProfileId}`,
    `Requester: ${task.requesterUserId}`,
    `CWD: ${task.cwd}`,
    `Iterations: ${task.currentIteration}/${task.maxIterations}`,
    `Created: ${task.createdAt}`,
    `Started: ${task.startedAt ?? "-"}`,
    `Finished: ${task.finishedAt ?? "-"}`,
    `Output: ${task.finalOutput ?? "-"}`,
    `Error: ${task.errorCode ?? "-"} ${task.errorMessage ?? ""}`.trim()
  ].join("\n");

  const toolCallSection =
    toolCalls.length === 0
      ? "Tool Calls: none"
      : [
          "Tool Calls:",
          ...toolCalls.map(
            (toolCall) =>
              `- ${toolCall.toolCallId} ${toolCall.toolName} ${toolCall.status} ${toolCall.summary ?? ""}`.trim()
          )
        ].join("\n");

  const approvalSection =
    approvals.length === 0
      ? "Approvals: none"
      : [
          "Approvals:",
          ...approvals.map(
            (approval) =>
              `- ${approval.approvalId} ${approval.toolName} ${approval.status} reviewer=${approval.reviewerId ?? "-"} expires=${approval.expiresAt}`
          )
        ].join("\n");

  const scheduleSection =
    scheduleRuns.length === 0
      ? "Schedule Runs: none"
      : [
          "Schedule Runs:",
          ...scheduleRuns.map(
            (scheduleRun) =>
              `- ${scheduleRun.runId} ${scheduleRun.status} attempt=${scheduleRun.attemptNumber} schedule=${scheduleRun.scheduleId}`
          )
        ].join("\n");

  const inboxSection =
    inboxItems.length === 0
      ? "Inbox Items: none"
      : [
          "Inbox Items:",
          ...inboxItems.map((item) => `- ${item.inboxId} ${item.category} ${item.status} ${item.title}`)
        ].join("\n");

  return `${header}\n${toolCallSection}\n${approvalSection}\n${scheduleSection}\n${inboxSection}`;
}

export function formatInboxList(items: InboxItem[]): string {
  if (items.length === 0) {
    return "No inbox items found.";
  }
  return items
    .map(
      (item) =>
        `${item.inboxId} | ${item.status} | ${item.severity} | ${item.category} | task=${item.taskId ?? "-"} | ${item.title}`
    )
    .join("\n");
}

export function formatInboxDetail(item: InboxItem): string {
  return [
    `Inbox ID: ${item.inboxId}`,
    `User: ${item.userId}`,
    `Status: ${item.status}`,
    `Category: ${item.category}`,
    `Severity: ${item.severity}`,
    `Task ID: ${item.taskId ?? "-"}`,
    `Thread ID: ${item.threadId ?? "-"}`,
    `Schedule Run ID: ${item.scheduleRunId ?? "-"}`,
    `Approval ID: ${item.approvalId ?? "-"}`,
    `Experience ID: ${item.experienceId ?? "-"}`,
    `Skill ID: ${item.skillId ?? "-"}`,
    `Title: ${item.title}`,
    `Summary: ${item.summary}`,
    `Body: ${item.bodyMd ?? "-"}`,
    `Action Hint: ${item.actionHint ?? "-"}`,
    `Created: ${item.createdAt}`,
    `Updated: ${item.updatedAt}`,
    `Done: ${item.doneAt ?? "-"}`
  ].join("\n");
}

export function formatTrace(traceEvents: TraceEvent[]): string {
  if (traceEvents.length === 0) {
    return "No trace events found.";
  }

  return traceEvents.map((event) => formatTraceEvent(event)).join("\n\n");
}

export function formatTaskTimeline(report: TaskTimelineReport): string {
  if (report.task === null) {
    return "Task not found.";
  }

  if (report.entries.length === 0) {
    return `Timeline for ${report.task.taskId}: no timeline events found.`;
  }

  return [
    `Timeline for ${report.task.taskId}`,
    `Status: ${report.task.status}`,
    ...report.entries.map(
      (entry) =>
        `#${entry.sequence} ${entry.iteration === null ? "iter=-" : `iter=${entry.iteration}`} [${entry.stage}] ${entry.eventType} ${entry.actor} | ${entry.detail}`
    )
  ].join("\n");
}

export function formatTraceContextDebug(report: ContextTraceDebugReport): string {
  if (report.task === null) {
    return "Task not found.";
  }

  return JSON.stringify(
    {
      taskId: report.task.taskId,
      profile: report.task.agentProfileId,
      contextAssembly: report.contextAssembly,
      memoryRecall: report.memoryRecall,
      reviewerTrace: report.reviewerTrace,
      latestThreadSnapshot: report.latestThreadSnapshot
    },
    null,
    2
  );
}

export function formatApprovalList(approvals: ApprovalRecord[]): string {
  if (approvals.length === 0) {
    return "No pending approvals.";
  }

  return approvals
    .map(
      (approval) =>
        `${approval.approvalId} | ${approval.taskId} | ${approval.toolName} | ${approval.status} | expires=${approval.expiresAt}`
    )
    .join("\n");
}

export function formatAuditLog(entries: AuditLogRecord[]): string {
  if (entries.length === 0) {
    return "No audit log entries found.";
  }

  return entries
    .map(
      (entry) =>
        `${entry.createdAt} | ${entry.action} | ${entry.outcome} | ${entry.actor} | ${entry.summary}`
    )
    .join("\n");
}

export function summarizeTrace(traceEvents: TraceEvent[]): string {
  if (traceEvents.length === 0) {
    return "No trace events were recorded for this task.";
  }
  const stageCounts = traceEvents.reduce<Record<string, number>>((acc, event) => {
    acc[event.stage] = (acc[event.stage] ?? 0) + 1;
    return acc;
  }, {});
  const first = traceEvents[0];
  const last = traceEvents.at(-1);
  return `Trace contains ${traceEvents.length} events across ${Object.keys(stageCounts).length} stages (${Object.entries(stageCounts).map(([key, value]) => `${key}=${value}`).join(", ")}). Flow starts with ${first?.eventType ?? "-"} and ends with ${last?.eventType ?? "-"}.`;
}

export function summarizeAudit(entries: AuditLogRecord[]): string {
  if (entries.length === 0) {
    return "No audit actions were captured.";
  }
  const actionCounts = entries.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.action] = (acc[entry.action] ?? 0) + 1;
    return acc;
  }, {});
  return `Audit contains ${entries.length} entries with actions: ${Object.entries(actionCounts).map(([name, count]) => `${name}=${count}`).join(", ")}.`;
}

export function formatDoctorReport(report: AgentDoctorReport): string {
  return [
    `Runtime Version: ${report.runtimeVersion}`,
    `Runtime Config Source: ${report.runtimeConfigSource}`,
    `Runtime Config Path: ${report.runtimeConfigPath}`,
    `Token Budget: input=${report.tokenBudget.inputLimit} output=${report.tokenBudget.outputLimit} reserved=${report.tokenBudget.reservedOutput}`,
    `Allowed Fetch Hosts: ${report.allowedFetchHosts.join(", ")}`,
    `Provider: ${report.providerName}`,
    `Model: ${report.modelName ?? "-"}`,
    `Config Source: ${report.configSource}`,
    `Config Path: ${report.configPath}`,
    `API Key Configured: ${report.apiKeyConfigured ? "yes" : "no"}`,
    `Endpoint Reachable: ${formatTernary(report.endpointReachable)}`,
    `Model Configured: ${report.modelConfigured ? "yes" : "no"}`,
    `Model Available: ${formatTernary(report.modelAvailable)}`,
    `Timeout (ms): ${report.timeoutMs}`,
    `Max Retries: ${report.maxRetries}`,
    `Provider Health: ${report.providerHealthMessage}`,
    `Node: ${report.nodeVersion}`,
    `pnpm: ${report.pnpmVersion ?? "-"}`,
    `Corepack: ${report.corepackAvailable ? "yes" : "no"}`,
    `Workspace Root: ${report.workspaceRoot}`,
    `Database Path: ${report.databasePath}`,
    `Database Reachable: ${report.databaseReachable ? "yes" : "no"}`,
    `Schema Version: ${report.schemaVersion ?? "-"}`,
    `Build Fresh: ${formatTernary(report.distFresh)}`,
    `Config Files: ${report.configFiles.map((entry) => `${entry.file}=${entry.exists ? (entry.parseable ? "ok" : "invalid") : "missing"}`).join(", ")}`,
    `Experience Records: total=${report.experienceStats.total} candidate=${report.experienceStats.candidate} accepted=${report.experienceStats.accepted} promoted=${report.experienceStats.promoted} rejected=${report.experienceStats.rejected} stale=${report.experienceStats.stale}`,
    `Skills: total=${report.skillStats.total} enabled=${report.skillStats.enabled} issues=${report.skillStats.issues}`,
    `Shell: ${report.shell ?? "-"}`,
    `Issues: ${report.issues.length === 0 ? "none" : report.issues.join("; ")}`
  ].join("\n");
}

export function formatProviderCatalog(
  currentProviderName: string,
  providers: Array<{
    displayName: string;
    name: string;
    supportsStreaming: boolean;
    supportsToolCalls: boolean;
  }>
): string {
  return providers
    .map(
      (provider) =>
        `${provider.name} | ${provider.displayName} | current=${provider.name === currentProviderName ? "yes" : "no"} | tools=${provider.supportsToolCalls ? "yes" : "no"} | streaming=${provider.supportsStreaming ? "yes" : "no"}`
    )
    .join("\n");
}

export function formatCurrentProvider(config: {
  baseUrl: string | null;
  configPath: string;
  configSource: string;
  maxRetries: number;
  model: string | null;
  name: string;
  timeoutMs: number;
}): string {
  return [
    `Provider: ${config.name}`,
    `Model: ${config.model ?? "-"}`,
    `Base URL: ${config.baseUrl ?? "-"}`,
    `Config Source: ${config.configSource}`,
    `Config Path: ${config.configPath}`,
    `Timeout (ms): ${config.timeoutMs}`,
    `Max Retries: ${config.maxRetries}`
  ].join("\n");
}

export function formatProviderHealth(report: {
  apiKeyConfigured: boolean;
  endpointReachable: boolean | null;
  errorCategory?: string;
  latencyMs?: number;
  message: string;
  modelAvailable: boolean | null;
  modelConfigured: boolean;
  modelName: string | null;
  ok: boolean;
  providerName: string;
}): string {
  return [
    `Provider: ${report.providerName}`,
    `Model: ${report.modelName ?? "-"}`,
    `Healthy: ${report.ok ? "yes" : "no"}`,
    `API Key Configured: ${report.apiKeyConfigured ? "yes" : "no"}`,
    `Endpoint Reachable: ${formatTernary(report.endpointReachable)}`,
    `Model Configured: ${report.modelConfigured ? "yes" : "no"}`,
    `Model Available: ${formatTernary(report.modelAvailable)}`,
    `Latency (ms): ${report.latencyMs ?? "-"}`,
    `Error Category: ${report.errorCategory ?? "-"}`,
    `Message: ${report.message}`
  ].join("\n");
}

export function formatProviderStats(stats: ProviderStatsSnapshot | Record<string, unknown> | null): string {
  if (stats === null) {
    return "Provider statistics are not available.";
  }
  if (!("providerName" in stats)) {
    return JSON.stringify(stats, null, 2);
  }

  const typed = stats as ProviderStatsSnapshot;
  return [
    `Provider: ${typed.providerName}`,
    `Requests: ${typed.totalRequests}`,
    `Successes: ${typed.successfulRequests}`,
    `Failures: ${typed.failedRequests}`,
    `Average Latency (ms): ${typed.averageLatencyMs}`,
    `Retries: ${typed.retryCount}`,
    `Last Error Category: ${typed.lastErrorCategory ?? "-"}`,
    `Last Request At: ${typed.lastRequestAt ?? "-"}`,
    `Token Usage: input=${typed.tokenUsage.inputTokens} output=${typed.tokenUsage.outputTokens} total=${typed.tokenUsage.totalTokens ?? typed.tokenUsage.inputTokens + typed.tokenUsage.outputTokens}`
  ].join("\n");
}

export function formatRunError(error: {
  code: string;
  details?: Record<string, unknown> | undefined;
  message: string;
}): string {
  const category =
    typeof error.details?.providerCategory === "string" ? error.details.providerCategory : null;
  const summary =
    typeof error.details?.providerErrorSummary === "string"
      ? error.details.providerErrorSummary
      : error.message;
  const retryCount =
    typeof error.details?.retryCount === "number" ? error.details.retryCount : 0;

  return category === null
    ? `${error.code}: ${error.message}`
    : `${error.code}: ${summary} category=${category} retries=${retryCount}`;
}

export function formatMemoryList(memories: MemoryRecord[]): string {
  if (memories.length === 0) {
    return "No memories found.";
  }

  return memories
    .map(
      (memory) =>
        `${memory.memoryId} | ${displayMemoryScope(memory.scope)}:${memory.scopeKey} | ${memory.status} | confidence=${memory.confidence.toFixed(2)} | privacy=${memory.privacyLevel} | ${memory.title}`
    )
    .join("\n");
}

export function formatExperienceList(experiences: ExperienceRecord[]): string {
  if (experiences.length === 0) {
    return "No experiences found.";
  }

  return experiences
    .map(
      (experience) =>
        `${experience.experienceId} | ${experience.type} | ${experience.sourceType} | ${experience.status} | value=${experience.valueScore.toFixed(2)} confidence=${experience.confidence.toFixed(2)} | target=${experience.promotionTarget ?? "-"} | ${experience.title}`
    )
    .join("\n");
}

export function formatExperienceDetail(experience: ExperienceRecord | null): string {
  if (experience === null) {
    return "Experience not found.";
  }

  return [
    `Experience ID: ${experience.experienceId}`,
    `Type: ${experience.type}`,
    `Source: ${experience.sourceType}`,
    `Status: ${experience.status}`,
    `Value: ${experience.valueScore.toFixed(2)}`,
    `Confidence: ${experience.confidence.toFixed(2)}`,
    `Scope: ${experience.scope.scope}:${experience.scope.scopeKey}`,
    `Paths: ${experience.scope.paths.join(", ") || "-"}`,
    `Promotion Target: ${experience.promotionTarget ?? "-"}`,
    `Promoted Memory: ${experience.promotedMemoryId ?? "-"}`,
    `Provenance: task=${experience.provenance.taskId ?? "-"} tool=${experience.provenance.toolCallId ?? "-"} reviewer=${experience.provenance.reviewerId ?? "-"} label=${experience.provenance.sourceLabel}`,
    `Keywords: ${experience.keywords.join(", ")}`,
    `Phrases: ${experience.keywordPhrases.join(", ") || "-"}`,
    `Summary: ${experience.summary}`,
    `Content: ${experience.content}`
  ].join("\n");
}

export function formatExperienceSearch(candidates: ExperienceRecallCandidate[]): string {
  if (candidates.length === 0) {
    return "No matching experiences found.";
  }

  return candidates
    .map(
      (candidate) =>
        `${candidate.experience.experienceId} | score=${candidate.finalScore.toFixed(2)} keyword=${candidate.keywordScore.toFixed(2)} phrase=${candidate.phraseScore.toFixed(2)} structured=${candidate.structuredScore.toFixed(2)} | ${candidate.experience.status} | target=${candidate.experience.promotionTarget ?? "-"} | ${candidate.experience.title}\n  ${candidate.explanation}\n  provenance=${candidate.experience.provenance.sourceLabel} task=${candidate.experience.provenance.taskId ?? "-"} reviewer=${candidate.experience.provenance.reviewerId ?? "-"}`
    )
    .join("\n");
}

export function formatSkillList(result: SkillListResult): string {
  const skillLines =
    result.skills.length === 0
      ? ["No enabled skills found."]
      : result.skills.map(
          (skill) =>
            `${skill.id} | ${skill.namespace}/${skill.name} | ${skill.version} | category=${skill.category} | tags=${skill.tags.join(",") || "-"} | source=${skill.source} | experiences=${skill.sourceExperienceIds.join(",") || "-"}`
        );
  const issueLines =
    result.issues.length === 0
      ? []
      : [
          "Issues:",
          ...result.issues.map(
            (issue) =>
              `- ${issue.code} | skill=${issue.skillId ?? "-"} | path=${issue.path} | ${issue.detail}`
          )
        ];
  return [...skillLines, ...issueLines].join("\n");
}

export function formatSkillView(skill: SkillView | null): string {
  if (skill === null) {
    return "Skill not found.";
  }

  return [
    `Skill ID: ${skill.metadata.id}`,
    `Name: ${skill.metadata.namespace}/${skill.metadata.name}`,
    `Version: ${skill.metadata.version}`,
    `Category: ${skill.metadata.category}`,
    `Disabled: ${skill.metadata.disabled ? "yes" : "no"}`,
    `Platforms: ${skill.metadata.platforms.join(", ")}`,
    `Tags: ${skill.metadata.tags.join(", ") || "-"}`,
    `Related: ${skill.metadata.relatedSkills.join(", ") || "-"}`,
    `Source Experiences: ${skill.metadata.sourceExperienceIds.join(", ") || "-"}`,
    `Attachments: references=${skill.metadata.attachmentCounts.references} templates=${skill.metadata.attachmentCounts.templates} scripts=${skill.metadata.attachmentCounts.scripts} assets=${skill.metadata.attachmentCounts.assets}`,
    `Description: ${skill.metadata.description}`,
    `Body:\n${skill.body}`,
    skill.loadedAttachments.length === 0
      ? "Loaded Attachments: none"
      : [
          "Loaded Attachments:",
          ...skill.loadedAttachments.map(
            (attachment) => `- ${attachment.kind}:${attachment.path}\n${attachment.content}`
          )
        ].join("\n")
  ].join("\n");
}

export function formatSkillDraft(draft: SkillDraftRecord): string {
  return [
    `Draft ID: ${draft.draftId}`,
    `Draft Path: ${draft.draftPath}`,
    `Target Skill: ${draft.targetSkillId}`,
    `Source Experiences: ${draft.sourceExperienceIds.join(", ")}`
  ].join("\n");
}

export function formatMemoryScope(
  scope: string,
  scopeKey: string,
  memories: MemoryRecord[],
  snapshots: MemorySnapshotRecord[]
): string {
  const memorySection =
    memories.length === 0
      ? "Memories: none"
      : ["Memories:", ...memories.map((memory) => formatMemoryDetail(memory))].join("\n");
  const snapshotSection =
    snapshots.length === 0
      ? "Snapshots: none"
      : [
          "Snapshots:",
          ...snapshots.map(
            (snapshot) =>
              `- ${snapshot.snapshotId} ${snapshot.label} created=${snapshot.createdAt} count=${snapshot.memoryIds.length}`
          )
        ].join("\n");

  return [`Scope: ${displayMemoryScope(scope)}`, `Scope Key: ${scopeKey}`, memorySection, snapshotSection].join("\n");
}

export function formatSnapshot(snapshot: MemorySnapshotRecord): string {
  return [
    `Snapshot ID: ${snapshot.snapshotId}`,
    `Scope: ${displayMemoryScope(snapshot.scope)}`,
    `Scope Key: ${snapshot.scopeKey}`,
    `Label: ${snapshot.label}`,
    `Created By: ${snapshot.createdBy}`,
    `Created At: ${snapshot.createdAt}`,
    `Memory Count: ${snapshot.memoryIds.length}`,
    `Summary: ${snapshot.summary}`
  ].join("\n");
}

function formatMemoryDetail(memory: MemoryRecord): string {
  const conflicts =
    memory.conflictsWith.length === 0 ? "-" : memory.conflictsWith.join(",");

  return [
    `- ${memory.memoryId} ${memory.title}`,
    `  status=${memory.status} confidence=${memory.confidence.toFixed(2)} privacy=${memory.privacyLevel} source=${memory.sourceType}`,
    `  created=${memory.createdAt} updated=${memory.updatedAt} verified=${memory.lastVerifiedAt ?? "-"} expires=${memory.expiresAt ?? "-"}`,
    `  conflicts=${conflicts} supersedes=${memory.supersedes ?? "-"}`,
    `  summary=${memory.summary}`
  ].join("\n");
}

function formatTernary(value: boolean | null): string {
  if (value === null) {
    return "unknown";
  }

  return value ? "yes" : "no";
}

function displayMemoryScope(scope: string): string {
  if (scope === "agent") {
    return "profile";
  }
  if (scope === "session") {
    return "working";
  }
  return scope;
}

export function formatEvalReport(report: EvalReport): string {
  const typicalFailures =
    report.typicalFailures.length === 0
      ? "none"
      : report.typicalFailures
          .map(
            (failure) =>
              `${failure.taskFixtureId}(${failure.taskId}):${failure.failureReason}`
          )
          .join(", ");
  const categoryRates = Object.entries(report.categorySuccessRates);
  const categoryRateSummary =
    categoryRates.length === 0
      ? "none"
      : categoryRates
          .map(
            ([category, value]) =>
              `${category}:${value.succeeded}/${value.total} (${(value.successRate * 100).toFixed(1)}%)`
          )
          .join(", ");

  return [
    `Provider: ${report.providerName}`,
    `Model: ${report.modelName ?? "-"}`,
    `Total tasks: ${report.taskCount}`,
    `Success rate: ${(report.successRate * 100).toFixed(1)}%`,
    `Average duration: ${report.averageDurationMs.toFixed(1)}ms`,
    `Average rounds: ${report.averageRounds.toFixed(2)}`,
    report.tokenUsage.available
      ? `Token usage: total=${report.tokenUsage.totalTokens} input=${report.tokenUsage.totalInputTokens} output=${report.tokenUsage.totalOutputTokens} avgTotal=${report.tokenUsage.averageTotalTokens.toFixed(1)}`
      : "Token usage: unavailable",
    `Category success: ${categoryRateSummary}`,
    `Failure reasons: ${formatFailureReasons(report.failureReasonDistribution)}`,
    `Typical failed tasks: ${typicalFailures}`
  ].join("\n");
}

export function formatReplayReport(report: ReplayRunResult): string {
  const iterationLines = report.reference.iterationSummaries.map(
    (summary) =>
      `- iter=${summary.iteration} kind=${summary.modelResponseKind} tools=${summary.toolNames.join(",") || "-"} providerError=${summary.providerErrorCategory ?? "-"} final=${summary.finalOutcomeStatus}`
  );
  const toolLines =
    report.reference.toolCalls.length === 0
      ? ["- none"]
      : report.reference.toolCalls.map(
          (toolCall) =>
            `- iter=${toolCall.iteration} ${toolCall.toolName} ${toolCall.status} ${toolCall.summary ?? toolCall.errorMessage ?? ""}`.trim()
        );

  return [
    `Original task: ${report.reference.task.taskId}`,
    `Replay task: ${report.replayTask.taskId}`,
    `Provider mode: ${report.providerMode}`,
    `Original provider: ${report.reference.task.providerName}`,
    `Replay status: ${report.replayTask.status}`,
    `Replay from iteration: ${report.reference.fromIteration}`,
    `Diagnosis: ${report.reference.diagnosis.category} | ${report.reference.diagnosis.rationale}`,
    `Historical trace events: ${report.reference.selectedTrace.length}`,
    `Replay trace events: ${report.trace.length}`,
    `Historical tool references:`,
    ...toolLines,
    `Historical iteration chain:`,
    ...iterationLines
  ].join("\n");
}

export function formatBetaReadinessReport(report: BetaReadinessReport): string {
  return [
    `Generated at: ${report.generatedAt}`,
    `Overall: ${report.allPassed ? "pass" : "needs work"}`,
    ...report.checklist.map(
      (item) => `- ${item.ok ? "PASS" : "FAIL"} ${item.id} | ${item.title} | ${item.details}`
    )
  ].join("\n");
}

export function formatReleaseChecklistReport(report: ReleaseChecklistReport): string {
  return [
    `Generated at: ${report.generatedAt}`,
    `Overall: ${report.allPassed ? "pass" : "needs work"}`,
    ...report.items.map((item) => `- ${item.ok ? "PASS" : "FAIL"} ${item.id} | ${item.title} | ${item.details}`)
  ].join("\n");
}

function formatFailureReasons(failureReasons: Record<string, number>): string {
  const entries = Object.entries(failureReasons);
  if (entries.length === 0) {
    return "none";
  }

  return entries.map(([reason, count]) => `${reason}:${count}`).join(", ");
}
