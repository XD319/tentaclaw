import type {
  NextActionDraft,
  NextActionListQuery,
  NextActionRecord,
  NextActionRepository,
  NextActionUpdatePatch
} from "../../types/index.js";
import type { TraceService } from "../../tracing/trace-service.js";

export interface NextActionServiceDependencies {
  nextActionRepository: NextActionRepository;
  traceService: TraceService;
}

export class NextActionService {
  public constructor(private readonly dependencies: NextActionServiceDependencies) {}

  public create(record: NextActionDraft): NextActionRecord {
    const created = this.dependencies.nextActionRepository.create(record);
    this.record("next_action_created", created, `Next action created: ${created.title}`);
    return created;
  }

  public get(nextActionId: string): NextActionRecord | null {
    return this.dependencies.nextActionRepository.findById(nextActionId);
  }

  public list(query?: NextActionListQuery): NextActionRecord[] {
    return this.dependencies.nextActionRepository.list(query);
  }

  public update(nextActionId: string, patch: NextActionUpdatePatch): NextActionRecord {
    const updated = this.dependencies.nextActionRepository.update(nextActionId, patch);
    this.record("next_action_updated", updated, `Next action updated: ${updated.title}`);
    return updated;
  }

  public markActive(nextActionId: string): NextActionRecord {
    return this.update(nextActionId, {
      blockedReason: null,
      status: "active"
    });
  }

  public block(nextActionId: string, reason: string): NextActionRecord {
    const updated = this.dependencies.nextActionRepository.update(nextActionId, {
      blockedReason: reason,
      status: "blocked"
    });
    this.record("next_action_blocked", updated, `Next action blocked: ${updated.title}`);
    return updated;
  }

  public unblock(nextActionId: string): NextActionRecord {
    const updated = this.dependencies.nextActionRepository.update(nextActionId, {
      blockedReason: null,
      status: "active"
    });
    this.record("next_action_updated", updated, `Next action unblocked: ${updated.title}`);
    return updated;
  }

  public markDone(nextActionId: string): NextActionRecord {
    const updated = this.dependencies.nextActionRepository.update(nextActionId, {
      blockedReason: null,
      completedAt: new Date().toISOString(),
      status: "done"
    });
    this.record("next_action_done", updated, `Next action done: ${updated.title}`);
    return updated;
  }

  public cancel(nextActionId: string): NextActionRecord {
    return this.update(nextActionId, {
      completedAt: new Date().toISOString(),
      status: "cancelled"
    });
  }

  public reorder(threadId: string, orderedIds: string[]): NextActionRecord[] {
    const current = this.list({ threadId });
    const rankById = new Map<string, number>();
    orderedIds.forEach((id, index) => rankById.set(id, index));
    return current.map((action) =>
      this.dependencies.nextActionRepository.update(action.nextActionId, {
        rank: rankById.get(action.nextActionId) ?? action.rank
      })
    );
  }

  private record(
    eventType: "next_action_created" | "next_action_updated" | "next_action_blocked" | "next_action_done",
    action: NextActionRecord,
    summary: string
  ): void {
    this.dependencies.traceService.record({
      actor: "runtime.next-action",
      eventType,
      payload: {
        blockedReason: action.blockedReason,
        commitmentId: action.commitmentId,
        nextActionId: action.nextActionId,
        status: action.status,
        taskId: action.taskId,
        threadId: action.threadId,
        title: action.title
      },
      stage: "planning",
      summary,
      taskId: action.taskId ?? `thread:${action.threadId}`
    });
  }
}
