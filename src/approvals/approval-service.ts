import { randomUUID } from "node:crypto";

import { z } from "zod";

import { AppError } from "../runtime/app-error.js";
import type {
  ApprovalRecord,
  ApprovalRepository,
  ApprovalStatus,
  RuntimeErrorCode
} from "../types/index.js";

export interface ApprovalServiceConfig {
  approvalTtlMs: number;
  now?: () => Date;
}

const approvalResolutionSchema = z.object({
  action: z.enum(["allow", "deny"]),
  approvalId: z.string().min(1),
  reviewerId: z.string().min(1),
  reviewerNotes: z.string().optional()
});

export interface EnsureApprovalRequestInput {
  taskId: string;
  toolCallId: string;
  toolName: string;
  requesterUserId: string;
  reason: string;
  policyDecisionId: string;
}

export interface EnsureApprovalRequestResult {
  approval: ApprovalRecord;
  created: boolean;
}

export interface ApprovalResolutionInput {
  approvalId: string;
  action: "allow" | "deny";
  reviewerId: string;
  reviewerNotes?: string;
}

export class ApprovalService {
  private readonly now: () => Date;

  public constructor(
    private readonly approvalRepository: ApprovalRepository,
    private readonly config: ApprovalServiceConfig
  ) {
    this.now = config.now ?? (() => new Date());
  }

  public ensureApprovalRequest(input: EnsureApprovalRequestInput): EnsureApprovalRequestResult {
    const existing = this.approvalRepository.findLatestByToolCall(input.taskId, input.toolCallId);
    if (existing !== null) {
      return {
        approval: this.expireIfNeeded(existing),
        created: false
      };
    }

    const now = this.now();
    const approval = this.approvalRepository.create({
      approvalId: randomUUID(),
      expiresAt: new Date(now.getTime() + this.config.approvalTtlMs).toISOString(),
      policyDecisionId: input.policyDecisionId,
      reason: input.reason,
      requestedAt: now.toISOString(),
      requesterUserId: input.requesterUserId,
      taskId: input.taskId,
      toolCallId: input.toolCallId,
      toolName: input.toolName
    });

    return {
      approval,
      created: true
    };
  }

  public findById(approvalId: string): ApprovalRecord | null {
    const approval = this.approvalRepository.findById(approvalId);
    return approval === null ? null : this.expireIfNeeded(approval);
  }

  public listPending(): ApprovalRecord[] {
    const pendingApprovals = this.approvalRepository.listPending();
    const stillPending: ApprovalRecord[] = [];

    for (const approval of pendingApprovals) {
      const normalized = this.expireIfNeeded(approval);
      if (normalized.status === "pending") {
        stillPending.push(normalized);
      }
    }

    return stillPending;
  }

  public listByTaskId(taskId: string): ApprovalRecord[] {
    return this.approvalRepository
      .listByTaskId(taskId)
      .map((approval) => this.expireIfNeeded(approval));
  }

  public resolve(input: ApprovalResolutionInput): ApprovalRecord {
    const parsed = approvalResolutionSchema.parse(input);
    const approval = this.findById(parsed.approvalId);

    if (approval === null) {
      throw new AppError({
        code: "task_not_found",
        message: `Approval ${parsed.approvalId} was not found.`
      });
    }

    if (approval.status !== "pending") {
      return approval;
    }

    return this.approvalRepository.update(parsed.approvalId, {
      decidedAt: this.now().toISOString(),
      errorCode: parsed.action === "allow" ? null : "approval_denied",
      reviewerId: parsed.reviewerId,
      reviewerNotes: parsed.reviewerNotes ?? null,
      status: parsed.action === "allow" ? "approved" : "denied"
    });
  }

  public expirePending(): ApprovalRecord[] {
    const expired: ApprovalRecord[] = [];
    for (const approval of this.approvalRepository.listPending()) {
      const normalized = this.expireIfNeeded(approval);
      if (normalized.status === "timed_out") {
        expired.push(normalized);
      }
    }

    return expired;
  }

  public toErrorCode(status: ApprovalStatus): RuntimeErrorCode {
    switch (status) {
      case "approved":
        return "approval_required";
      case "denied":
        return "approval_denied";
      case "pending":
        return "approval_required";
      case "timed_out":
        return "approval_timeout";
      default:
        return "approval_required";
    }
  }

  private expireIfNeeded(approval: ApprovalRecord): ApprovalRecord {
    if (approval.status !== "pending") {
      return approval;
    }

    if (Date.parse(approval.expiresAt) > this.now().getTime()) {
      return approval;
    }

    return this.approvalRepository.update(approval.approvalId, {
      decidedAt: this.now().toISOString(),
      errorCode: "approval_timeout",
      reviewerId: "system",
      reviewerNotes: "Approval request timed out.",
      status: "timed_out"
    });
  }
}
