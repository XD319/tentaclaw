import type { AgentApplicationService } from "../../runtime/index.js";
import type { ThreadRecord } from "../../types/index.js";
import {
  buildTodaySummary,
  resolveRuntimeUserId,
  type TodaySummaryViewModel
} from "./today-summary.js";

export interface HomeSummaryAction {
  detail: string;
  key: string;
  label: string;
}

export interface HomeSummaryThreadCard {
  detail: string;
  headline: string;
  label: string;
}

export interface HomeSummaryViewModel {
  actions: HomeSummaryAction[];
  agenda: string[];
  assistantHint: string;
  recommendedThread: HomeSummaryThreadCard | null;
  title: string;
}

export function buildHomeSummary(
  service: Pick<
    AgentApplicationService,
    | "listCommitments"
    | "listInbox"
    | "listNextActions"
    | "listPendingApprovals"
    | "listSchedules"
    | "listThreads"
    | "showThread"
  >,
  options: { activeThreadId?: string | null } = {}
): HomeSummaryViewModel {
  const summary = buildTodaySummary(service as AgentApplicationService, options);
  const recommendedThread = buildRecommendedThreadCard(service, summary, options.activeThreadId ?? null);
  const actions = buildRecommendedActions(summary, recommendedThread);

  return {
    actions,
    agenda: buildAgenda(summary, recommendedThread),
    assistantHint:
      actions.length > 0
        ? `Try ${actions[0]!.label.toLowerCase()} or type a request in plain language.`
        : "Type a request in plain language to start a new thread.",
    recommendedThread,
    title: "Today at a glance"
  };
}

function buildAgenda(
  summary: TodaySummaryViewModel,
  recommendedThread: HomeSummaryThreadCard | null
): string[] {
  const agenda: string[] = [];
  const overdueRoutine = summary.dueRoutines.items[0];
  if (overdueRoutine !== undefined) {
    agenda.push(`Routine due: ${overdueRoutine.name}`);
  }
  const inboxItem = summary.inbox.items[0];
  if (inboxItem !== undefined) {
    agenda.push(`Inbox waiting: ${inboxItem.title}`);
  }
  const approval = summary.pendingApprovals.items[0];
  if (approval !== undefined) {
    agenda.push(`Decision needed: ${approval.toolName}`);
  }
  if (agenda.length === 0 && recommendedThread !== null) {
    agenda.push(recommendedThread.detail);
  }
  if (agenda.length === 0) {
    agenda.push("No urgent items. You can start a new task or continue from history.");
  }
  return agenda.slice(0, 3);
}

function buildRecommendedActions(
  summary: TodaySummaryViewModel,
  recommendedThread: HomeSummaryThreadCard | null
): HomeSummaryAction[] {
  const actions: HomeSummaryAction[] = [];
  const approval = summary.pendingApprovals.items[0];
  if (approval !== undefined) {
    actions.push({
      detail: `Resolve ${approval.toolName} before it expires.`,
      key: "approval",
      label: "Review pending approval"
    });
  }
  const inboxItem = summary.inbox.items[0];
  if (inboxItem !== undefined) {
    actions.push({
      detail: `Open ${inboxItem.title}.`,
      key: "inbox",
      label: "Triage inbox"
    });
  }
  const routine = summary.dueRoutines.items[0];
  if (routine !== undefined) {
    actions.push({
      detail: `Run or inspect ${routine.name}.`,
      key: "routine",
      label: "Check due routine"
    });
  }
  if (recommendedThread !== null) {
    actions.push({
      detail: recommendedThread.detail,
      key: "thread",
      label: "Continue recent thread"
    });
  }
  if (actions.length === 0) {
    actions.push({
      detail: "Start with a plain-language goal or ask for today's plan.",
      key: "start",
      label: "Start a new task"
    });
  }
  return actions.slice(0, 3);
}

function buildRecommendedThreadCard(
  service: Pick<AgentApplicationService, "showThread">,
  summary: TodaySummaryViewModel,
  activeThreadId: string | null
): HomeSummaryThreadCard | null {
  const thread = pickRecommendedThread(summary.threads.items, activeThreadId);
  if (thread === null) {
    return null;
  }
  const detail = service.showThread(thread.threadId);
  const headline =
    detail.state.currentObjective?.title ??
    detail.state.nextAction?.title ??
    detail.inboxItems[0]?.title ??
    thread.title;
  const suffix =
    detail.state.blockedReason ??
    detail.state.pendingDecision ??
    detail.state.nextAction?.title ??
    (detail.runs[0] !== undefined ? `recent run ${detail.runs[0]!.status}` : "ready to continue");

  return {
    detail: suffix,
    headline,
    label: thread.title
  };
}

function pickRecommendedThread(
  threads: ThreadRecord[],
  activeThreadId: string | null
): ThreadRecord | null {
  if (threads.length === 0) {
    return null;
  }
  if (activeThreadId !== null) {
    return threads.find((thread) => thread.threadId === activeThreadId) ?? threads[0] ?? null;
  }
  const userId = resolveRuntimeUserId();
  return threads.find((thread) => thread.ownerUserId === userId) ?? threads[0] ?? null;
}
