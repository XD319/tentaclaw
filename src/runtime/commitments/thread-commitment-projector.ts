import type {
  CommitmentRecord,
  NextActionRecord,
  ThreadCommitmentState
} from "../../types/index.js";

import type { CommitmentService } from "./commitment-service.js";
import type { NextActionService } from "./next-action-service.js";
import type { SessionSnapshotService } from "../context/session-snapshot-service.js";

export interface ThreadCommitmentProjectorDependencies {
  commitmentService: CommitmentService;
  nextActionService: NextActionService;
  snapshotService: SessionSnapshotService;
}

export class ThreadCommitmentProjector {
  public constructor(private readonly dependencies: ThreadCommitmentProjectorDependencies) {}

  public project(threadId: string): ThreadCommitmentState {
    const commitments = this.dependencies.commitmentService.list({
      statuses: ["open", "in_progress", "blocked", "waiting_decision"],
      threadId
    });
    const nextActions = this.dependencies.nextActionService.list({
      statuses: ["active", "blocked", "pending"],
      threadId
    });
    const latestSnapshot = this.dependencies.snapshotService.findLatestByThread(threadId);
    const currentObjective = pickCurrentObjective(commitments);
    const nextAction = pickNextAction(nextActions);
    return {
      activeNextActions: nextActions,
      blockedReason:
        nextAction?.blockedReason ??
        currentObjective?.blockedReason ??
        latestSnapshot?.blockedReason ??
        null,
      currentObjective,
      nextAction,
      openCommitments: commitments,
      pendingDecision: currentObjective?.pendingDecision ?? null
    };
  }
}

function pickCurrentObjective(items: CommitmentRecord[]): CommitmentRecord | null {
  return items.find((item) => item.status === "in_progress") ?? items[0] ?? null;
}

function pickNextAction(items: NextActionRecord[]): NextActionRecord | null {
  return items.find((item) => item.status === "active") ?? items[0] ?? null;
}
