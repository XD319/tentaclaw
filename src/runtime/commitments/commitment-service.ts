import type {
  CommitmentDraft,
  CommitmentListQuery,
  CommitmentRecord,
  CommitmentRepository,
  CommitmentUpdatePatch
} from "../../types/index.js";
import type { TraceService } from "../../tracing/trace-service.js";

export interface CommitmentServiceDependencies {
  commitmentRepository: CommitmentRepository;
  traceService: TraceService;
}

export class CommitmentService {
  public constructor(private readonly dependencies: CommitmentServiceDependencies) {}

  public create(record: CommitmentDraft): CommitmentRecord {
    const created = this.dependencies.commitmentRepository.create(record);
    this.record("commitment_created", created, `Commitment created: ${created.title}`);
    return created;
  }

  public get(commitmentId: string): CommitmentRecord | null {
    return this.dependencies.commitmentRepository.findById(commitmentId);
  }

  public list(query?: CommitmentListQuery): CommitmentRecord[] {
    return this.dependencies.commitmentRepository.list(query);
  }

  public update(commitmentId: string, patch: CommitmentUpdatePatch): CommitmentRecord {
    const updated = this.dependencies.commitmentRepository.update(commitmentId, patch);
    this.record("commitment_updated", updated, `Commitment updated: ${updated.title}`);
    return updated;
  }

  public block(commitmentId: string, reason: string): CommitmentRecord {
    const updated = this.dependencies.commitmentRepository.update(commitmentId, {
      blockedReason: reason,
      status: "blocked"
    });
    this.record("commitment_blocked", updated, `Commitment blocked: ${updated.title}`);
    return updated;
  }

  public unblock(commitmentId: string): CommitmentRecord {
    const existing = this.require(commitmentId);
    const nextStatus = existing.pendingDecision === null ? "in_progress" : "waiting_decision";
    const updated = this.dependencies.commitmentRepository.update(commitmentId, {
      blockedReason: null,
      status: nextStatus
    });
    this.record("commitment_unblocked", updated, `Commitment unblocked: ${updated.title}`);
    return updated;
  }

  public setPendingDecision(commitmentId: string, pendingDecision: string): CommitmentRecord {
    const updated = this.dependencies.commitmentRepository.update(commitmentId, {
      pendingDecision,
      status: "waiting_decision"
    });
    this.record("commitment_updated", updated, `Commitment pending decision: ${updated.title}`);
    return updated;
  }

  public resolveDecision(commitmentId: string): CommitmentRecord {
    const existing = this.require(commitmentId);
    const nextStatus = existing.blockedReason === null ? "in_progress" : "blocked";
    const updated = this.dependencies.commitmentRepository.update(commitmentId, {
      pendingDecision: null,
      status: nextStatus
    });
    this.record("commitment_updated", updated, `Commitment decision resolved: ${updated.title}`);
    return updated;
  }

  public complete(commitmentId: string): CommitmentRecord {
    const updated = this.dependencies.commitmentRepository.update(commitmentId, {
      blockedReason: null,
      completedAt: new Date().toISOString(),
      pendingDecision: null,
      status: "completed"
    });
    this.record("commitment_completed", updated, `Commitment completed: ${updated.title}`);
    return updated;
  }

  public cancel(commitmentId: string): CommitmentRecord {
    const updated = this.dependencies.commitmentRepository.update(commitmentId, {
      completedAt: new Date().toISOString(),
      status: "cancelled"
    });
    this.record("commitment_cancelled", updated, `Commitment cancelled: ${updated.title}`);
    return updated;
  }

  private require(commitmentId: string): CommitmentRecord {
    const record = this.get(commitmentId);
    if (record === null) {
      throw new Error(`Commitment ${commitmentId} was not found.`);
    }
    return record;
  }

  private record(
    eventType:
      | "commitment_created"
      | "commitment_updated"
      | "commitment_blocked"
      | "commitment_unblocked"
      | "commitment_completed"
      | "commitment_cancelled",
    commitment: CommitmentRecord,
    summary: string
  ): void {
    this.dependencies.traceService.record({
      actor: "runtime.commitment",
      eventType,
      payload: {
        blockedReason: commitment.blockedReason,
        commitmentId: commitment.commitmentId,
        pendingDecision: commitment.pendingDecision,
        status: commitment.status,
        taskId: commitment.taskId,
        threadId: commitment.threadId,
        title: commitment.title
      },
      stage: "planning",
      summary,
      taskId: commitment.taskId ?? `thread:${commitment.threadId}`
    });
  }
}
