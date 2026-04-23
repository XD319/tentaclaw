import type { TraceEvent, TaskRecord } from "../../types/index.js";
import type { TraceService } from "../../tracing/trace-service.js";
import type { SessionSnapshotService } from "../context/session-snapshot-service.js";
import type { CommitmentService } from "./commitment-service.js";
import type { NextActionService } from "./next-action-service.js";

export interface CommitmentCollectorDependencies {
  traceService: TraceService;
  snapshotService: SessionSnapshotService;
  commitmentService: CommitmentService;
  nextActionService: NextActionService;
  findTask: (taskId: string) => TaskRecord | null;
}

export class CommitmentCollector {
  private unsubscribe: (() => void) | null = null;

  public constructor(private readonly dependencies: CommitmentCollectorDependencies) {}

  public start(): void {
    if (this.unsubscribe !== null) {
      return;
    }
    this.unsubscribe = this.dependencies.traceService.subscribe((event: TraceEvent) => {
      this.handleTrace(event);
    });
  }

  public stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private handleTrace(event: TraceEvent): void {
    switch (event.eventType) {
      case "task_created":
        this.onTaskCreated(event);
        return;
      case "thread_snapshot_created":
        this.onSnapshot(event);
        return;
      case "approval_requested":
        this.onApprovalRequested(event);
        return;
      case "approval_resolved":
        this.onApprovalResolved(event);
        return;
      case "task_success":
        this.onTaskSuccess(event);
        return;
      case "task_failure":
        this.onTaskFailure(event);
        return;
      default:
        return;
    }
  }

  private onTaskCreated(event: Extract<TraceEvent, { eventType: "task_created" }>): void {
    const task = this.dependencies.findTask(event.taskId);
    if (task?.threadId === undefined || task.threadId === null) {
      return;
    }
    const existing = this.dependencies.commitmentService.list({
      statuses: ["open", "in_progress", "blocked", "waiting_decision"],
      threadId: task.threadId
    });
    if (existing.length === 0) {
      const commitment = this.dependencies.commitmentService.create({
        ownerUserId: task.requesterUserId,
        source: "user_request",
        sourceTraceId: event.eventId,
        status: "in_progress",
        summary: task.input,
        taskId: task.taskId,
        threadId: task.threadId,
        title: task.input.slice(0, 160)
      });
      this.dependencies.nextActionService.create({
        commitmentId: commitment.commitmentId,
        rank: 0,
        source: "user_request",
        sourceTraceId: event.eventId,
        status: "active",
        taskId: task.taskId,
        threadId: task.threadId,
        title: task.input.slice(0, 160)
      });
      return;
    }
    const actions = this.dependencies.nextActionService.list({
      statuses: ["pending", "active", "blocked"],
      threadId: task.threadId
    });
    if (actions.length === 0) {
      this.dependencies.nextActionService.create({
        commitmentId: existing[0]?.commitmentId ?? null,
        rank: 0,
        source: "user_request",
        sourceTraceId: event.eventId,
        status: "active",
        taskId: task.taskId,
        threadId: task.threadId,
        title: task.input.slice(0, 160)
      });
    }
  }

  private onSnapshot(event: Extract<TraceEvent, { eventType: "thread_snapshot_created" }>): void {
    const snapshot = this.dependencies.snapshotService.findById(event.payload.snapshotId);
    if (snapshot === null) {
      return;
    }
    const commitments = this.dependencies.commitmentService.list({
      statuses: ["open", "in_progress", "blocked", "waiting_decision"],
      threadId: snapshot.threadId
    });
    const objective = snapshot.goal.trim().slice(0, 160);
    const commitment =
      commitments[0] ??
      this.dependencies.commitmentService.create({
        ownerUserId: "local-user",
        source: "snapshot",
        sourceTraceId: event.eventId,
        status: "in_progress",
        summary: snapshot.summary,
        taskId: snapshot.taskId,
        threadId: snapshot.threadId,
        title: objective.length > 0 ? objective : "Continue thread objective"
      });
    if (snapshot.blockedReason !== null && snapshot.blockedReason.length > 0) {
      this.dependencies.commitmentService.block(commitment.commitmentId, snapshot.blockedReason);
    }
    const existing = this.dependencies.nextActionService.list({
      statuses: ["pending", "active", "blocked"],
      threadId: snapshot.threadId
    });
    if (existing.length === 0) {
      snapshot.nextActions.forEach((title, index) => {
        this.dependencies.nextActionService.create({
          commitmentId: commitment.commitmentId,
          rank: index,
          source: "snapshot",
          sourceTraceId: event.eventId,
          status: index === 0 ? "active" : "pending",
          taskId: snapshot.taskId,
          threadId: snapshot.threadId,
          title
        });
      });
    }
  }

  private onApprovalRequested(event: Extract<TraceEvent, { eventType: "approval_requested" }>): void {
    const task = this.dependencies.findTask(event.taskId);
    if (task?.threadId === undefined || task.threadId === null) {
      return;
    }
    const active = this.dependencies.nextActionService.list({
      statuses: ["active", "pending"],
      threadId: task.threadId
    })[0];
    if (active !== undefined) {
      this.dependencies.nextActionService.block(
        active.nextActionId,
        `awaiting approval: ${event.payload.toolName}`
      );
    }
  }

  private onApprovalResolved(event: Extract<TraceEvent, { eventType: "approval_resolved" }>): void {
    const task = this.dependencies.findTask(event.taskId);
    if (task?.threadId === undefined || task.threadId === null) {
      return;
    }
    const blocked = this.dependencies.nextActionService.list({
      status: "blocked",
      threadId: task.threadId
    })[0];
    if (blocked === undefined) {
      return;
    }
    if (event.payload.status === "approved") {
      this.dependencies.nextActionService.unblock(blocked.nextActionId);
      return;
    }
    this.dependencies.nextActionService.block(
      blocked.nextActionId,
      `approval ${event.payload.status}: ${event.payload.toolName}`
    );
  }

  private onTaskSuccess(event: Extract<TraceEvent, { eventType: "task_success" }>): void {
    const task = this.dependencies.findTask(event.taskId);
    if (task?.threadId === undefined || task.threadId === null) {
      return;
    }
    const active = this.dependencies.nextActionService.list({
      statuses: ["active", "pending", "blocked"],
      threadId: task.threadId
    })[0];
    if (active === undefined) {
      return;
    }
    this.dependencies.nextActionService.markDone(active.nextActionId);
    const remaining = this.dependencies.nextActionService.list({
      statuses: ["active", "pending", "blocked"],
      threadId: task.threadId
    });
    if (remaining.length === 0 && active.commitmentId !== null) {
      this.dependencies.commitmentService.complete(active.commitmentId);
    }
  }

  private onTaskFailure(event: Extract<TraceEvent, { eventType: "task_failure" }>): void {
    const task = this.dependencies.findTask(event.taskId);
    if (task?.threadId === undefined || task.threadId === null) {
      return;
    }
    const active = this.dependencies.nextActionService.list({
      statuses: ["active", "pending", "blocked"],
      threadId: task.threadId
    })[0];
    if (active === undefined) {
      return;
    }
    this.dependencies.nextActionService.block(
      active.nextActionId,
      `${event.payload.errorCode}: ${event.payload.errorMessage}`
    );
  }
}
