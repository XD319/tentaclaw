import type { DatabaseSync } from "node:sqlite";

import type {
  ApprovalDraft,
  ApprovalRecord,
  ApprovalRepository,
  ApprovalUpdatePatch
} from "../../types/index.js";
import { canTransitionApprovalStatus } from "../../types/index.js";

interface ApprovalRow {
  approval_id: string;
  task_id: string;
  tool_call_id: string;
  tool_name: string;
  requester_user_id: string;
  status: ApprovalRecord["status"];
  reason: string;
  requested_at: string;
  expires_at: string;
  decided_at: string | null;
  reviewer_id: string | null;
  reviewer_notes: string | null;
  policy_decision_id: string;
  error_code: ApprovalRecord["errorCode"];
}

export class SqliteApprovalRepository implements ApprovalRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(record: ApprovalDraft): ApprovalRecord {
    this.database
      .prepare(
        `
          INSERT INTO approvals (
            approval_id,
            task_id,
            tool_call_id,
            tool_name,
            requester_user_id,
            status,
            reason,
            requested_at,
            expires_at,
            decided_at,
            reviewer_id,
            reviewer_notes,
            policy_decision_id,
            error_code
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        record.approvalId,
        record.taskId,
        record.toolCallId,
        record.toolName,
        record.requesterUserId,
        "pending",
        record.reason,
        record.requestedAt,
        record.expiresAt,
        null,
        null,
        null,
        record.policyDecisionId,
        null
      );

    const created = this.findById(record.approvalId);
    if (created === null) {
      throw new Error(`Approval ${record.approvalId} was not persisted.`);
    }

    return created;
  }

  public findById(approvalId: string): ApprovalRecord | null {
    const row = this.database
      .prepare("SELECT * FROM approvals WHERE approval_id = ?")
      .get(approvalId) as ApprovalRow | undefined;

    return row === undefined ? null : this.mapRow(row);
  }

  public findLatestByToolCall(taskId: string, toolCallId: string): ApprovalRecord | null {
    const row = this.database
      .prepare(
        `
          SELECT *
          FROM approvals
          WHERE task_id = ? AND tool_call_id = ?
          ORDER BY requested_at DESC, approval_id DESC
          LIMIT 1
        `
      )
      .get(taskId, toolCallId) as ApprovalRow | undefined;

    return row === undefined ? null : this.mapRow(row);
  }

  public listByTaskId(taskId: string): ApprovalRecord[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM approvals WHERE task_id = ? ORDER BY requested_at ASC, approval_id ASC"
      )
      .all(taskId) as unknown as ApprovalRow[];

    return rows.map((row) => this.mapRow(row));
  }

  public listPending(): ApprovalRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY requested_at ASC")
      .all() as unknown as ApprovalRow[];

    return rows.map((row) => this.mapRow(row));
  }

  public update(approvalId: string, patch: ApprovalUpdatePatch): ApprovalRecord {
    const existing = this.findById(approvalId);
    if (existing === null) {
      throw new Error(`Approval ${approvalId} was not found.`);
    }

    const nextRecord: ApprovalRecord = {
      ...existing,
      decidedAt: patch.decidedAt === undefined ? existing.decidedAt : patch.decidedAt,
      errorCode: patch.errorCode === undefined ? existing.errorCode : patch.errorCode,
      reviewerId: patch.reviewerId === undefined ? existing.reviewerId : patch.reviewerId,
      reviewerNotes:
        patch.reviewerNotes === undefined ? existing.reviewerNotes : patch.reviewerNotes,
      status: patch.status ?? existing.status
    };

    if (
      nextRecord.status !== existing.status &&
      !canTransitionApprovalStatus(existing.status, nextRecord.status)
    ) {
      throw new Error(
        `Illegal approval status transition: ${existing.status} -> ${nextRecord.status}`
      );
    }

    this.database
      .prepare(
        `
          UPDATE approvals
          SET status = ?,
              decided_at = ?,
              reviewer_id = ?,
              reviewer_notes = ?,
              error_code = ?
          WHERE approval_id = ?
        `
      )
      .run(
        nextRecord.status,
        nextRecord.decidedAt,
        nextRecord.reviewerId,
        nextRecord.reviewerNotes,
        nextRecord.errorCode,
        approvalId
      );

    const updated = this.findById(approvalId);
    if (updated === null) {
      throw new Error(`Approval ${approvalId} disappeared after update.`);
    }

    return updated;
  }

  private mapRow(row: ApprovalRow): ApprovalRecord {
    return {
      approvalId: row.approval_id,
      decidedAt: row.decided_at,
      errorCode: row.error_code,
      expiresAt: row.expires_at,
      policyDecisionId: row.policy_decision_id,
      reason: row.reason,
      requestedAt: row.requested_at,
      requesterUserId: row.requester_user_id,
      reviewerId: row.reviewer_id,
      reviewerNotes: row.reviewer_notes,
      status: row.status,
      taskId: row.task_id,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name
    };
  }
}
