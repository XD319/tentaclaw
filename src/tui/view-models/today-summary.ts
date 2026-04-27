import type { AgentApplicationService } from "../../runtime/index.js";
import type {
  ApprovalRecord,
  CommitmentRecord,
  InboxItem,
  NextActionRecord,
  ThreadRecord
} from "../../types/index.js";

export interface TodaySummarySection<TItem> {
  items: TItem[];
  total: number;
}

export interface TodaySummaryViewModel {
  commitments: TodaySummarySection<CommitmentRecord>;
  inbox: TodaySummarySection<InboxItem>;
  nextActions: TodaySummarySection<NextActionRecord>;
  pendingApprovals: TodaySummarySection<ApprovalRecord>;
  threads: TodaySummarySection<ThreadRecord>;
  userId: string;
}

export interface BuildTodaySummaryOptions {
  activeThreadId?: string | null;
  limit?: number;
}

const DEFAULT_LIMIT = 5;

export function resolveRuntimeUserId(): string {
  return process.env.USERNAME ?? process.env.USER ?? "local-user";
}

export function buildTodaySummary(
  service: AgentApplicationService,
  options: BuildTodaySummaryOptions = {}
): TodaySummaryViewModel {
  const userId = resolveRuntimeUserId();
  const activeThreadId = options.activeThreadId ?? null;
  const limit = options.limit ?? DEFAULT_LIMIT;

  const threadsAll = service
    .listThreads("active")
    .filter((item) => item.ownerUserId === userId)
    .sort((left, right) => byIsoDesc(left.updatedAt, right.updatedAt));
  const threadIds = new Set(threadsAll.map((item) => item.threadId));

  const inboxAll = service
    .listInbox({ status: "pending", userId })
    .sort((left, right) => byIsoDesc(left.updatedAt, right.updatedAt));

  const commitmentsAll = service
    .listCommitments({
      ownerUserId: userId,
      statuses: ["open", "in_progress", "blocked", "waiting_decision"]
    })
    .sort((left, right) => byIsoDesc(left.updatedAt, right.updatedAt));

  const nextActionsAll = service
    .listNextActions({ statuses: ["active", "pending"] })
    .filter((item) => threadIds.has(item.threadId))
    .sort((left, right) => compareNextAction(left, right, activeThreadId));

  const pendingApprovalsAll = service
    .listPendingApprovals()
    .sort((left, right) => byIsoAsc(left.expiresAt, right.expiresAt));

  return {
    commitments: { items: prioritizeByThread(commitmentsAll, activeThreadId).slice(0, limit), total: commitmentsAll.length },
    inbox: { items: inboxAll.slice(0, limit), total: inboxAll.length },
    nextActions: { items: nextActionsAll.slice(0, limit), total: nextActionsAll.length },
    pendingApprovals: { items: pendingApprovalsAll.slice(0, limit), total: pendingApprovalsAll.length },
    threads: { items: prioritizeByThread(threadsAll, activeThreadId).slice(0, limit), total: threadsAll.length },
    userId
  };
}

export function formatTodaySummary(summary: TodaySummaryViewModel): string {
  return [
    `Today summary (user=${summary.userId})`,
    formatSection(
      "Inbox",
      summary.inbox.total,
      summary.inbox.items,
      (item) => `${item.inboxId.slice(0, 8)} | ${item.title} [${item.status}]`
    ),
    formatSection(
      "Threads",
      summary.threads.total,
      summary.threads.items,
      (item) => `${item.threadId.slice(0, 8)} | ${item.title} [${item.status}]`
    ),
    formatSection(
      "Commitments",
      summary.commitments.total,
      summary.commitments.items,
      (item) => `${item.commitmentId.slice(0, 8)} | ${item.title} [${item.status}]`
    ),
    formatSection(
      "Next Actions",
      summary.nextActions.total,
      summary.nextActions.items,
      (item) => `${item.nextActionId.slice(0, 8)} | ${item.title} [${item.status}]`
    ),
    formatSection(
      "Pending Approvals",
      summary.pendingApprovals.total,
      summary.pendingApprovals.items,
      (item) => `${item.approvalId.slice(0, 8)} | ${item.toolName} (expires ${item.expiresAt})`
    )
  ].join("\n");
}

export function formatThreadDetailForTui(
  service: AgentApplicationService,
  threadId: string
): string {
  const detail = service.showThread(threadId);
  if (detail.thread === null) {
    return `Thread ${threadId} not found.`;
  }
  return [
    `Thread ${detail.thread.threadId} | ${detail.thread.title}`,
    `status=${detail.thread.status} updatedAt=${detail.thread.updatedAt}`,
    `runs=${detail.runs.length} commitments=${detail.commitments.length} next_actions=${detail.nextActions.length} inbox=${detail.inboxItems.length}`
  ].join("\n");
}

function formatSection<TItem>(
  title: string,
  total: number,
  items: TItem[],
  toLine: (item: TItem) => string
): string {
  const head = `${title} (${total})`;
  if (items.length === 0) {
    return `${head}\n- none`;
  }
  return `${head}\n${items.map((item) => `- ${toLine(item)}`).join("\n")}`;
}

function compareNextAction(
  left: NextActionRecord,
  right: NextActionRecord,
  activeThreadId: string | null
): number {
  if (activeThreadId !== null) {
    const leftActive = left.threadId === activeThreadId;
    const rightActive = right.threadId === activeThreadId;
    if (leftActive !== rightActive) {
      return leftActive ? -1 : 1;
    }
  }
  if (left.threadId !== right.threadId) {
    return left.threadId.localeCompare(right.threadId);
  }
  if (left.rank !== right.rank) {
    return left.rank - right.rank;
  }
  return byIsoDesc(left.updatedAt, right.updatedAt);
}

function prioritizeByThread<TItem extends { threadId: string }>(
  items: TItem[],
  activeThreadId: string | null
): TItem[] {
  if (activeThreadId === null) {
    return items;
  }
  return [...items].sort((left, right) => {
    const leftActive = left.threadId === activeThreadId;
    const rightActive = right.threadId === activeThreadId;
    if (leftActive !== rightActive) {
      return leftActive ? -1 : 1;
    }
    return 0;
  });
}

function byIsoDesc(left: string, right: string): number {
  return right.localeCompare(left);
}

function byIsoAsc(left: string, right: string): number {
  return left.localeCompare(right);
}
