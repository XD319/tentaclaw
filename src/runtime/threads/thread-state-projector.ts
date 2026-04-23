import { randomUUID } from "node:crypto";

import type {
  ConversationMessage,
  ContextFragment,
  MemoryRepository,
  ThreadCommitmentState,
  ThreadRunRepository
} from "../../types/index.js";
import type { SessionSnapshotService } from "../context/session-snapshot-service.js";
import type { ThreadCommitmentProjector } from "../commitments/thread-commitment-projector.js";

export interface ThreadStateProjection {
  messages: ConversationMessage[];
  memoryContext: ContextFragment[];
  commitmentState: ThreadCommitmentState;
}

export interface ThreadStateProjectorDependencies {
  threadRunRepository: ThreadRunRepository;
  memoryRepository: MemoryRepository;
  snapshotService: SessionSnapshotService;
  commitmentProjector: ThreadCommitmentProjector;
}

export class ThreadStateProjector {
  public constructor(private readonly dependencies: ThreadStateProjectorDependencies) {}

  public projectState(threadId: string): ThreadStateProjection {
    const commitmentState = this.dependencies.commitmentProjector.project(threadId);
    const snapshot = this.dependencies.snapshotService.findLatestByThread(threadId);
    if (snapshot !== null) {
      const messages: ConversationMessage[] = [
        {
          role: "system",
          content: `[Thread Resume] Goal: ${snapshot.goal}`
        }
      ];
      if (snapshot.openLoops.length > 0) {
        messages.push({
          role: "system",
          content: `Open loops: ${snapshot.openLoops.join(", ")}`
        });
      }
      if (snapshot.blockedReason !== null && snapshot.blockedReason.length > 0) {
        messages.push({
          role: "system",
          content: `Blocked: ${snapshot.blockedReason}`
        });
      }
      if (snapshot.nextActions.length > 0) {
        messages.push({
          role: "system",
          content: `Next actions: ${snapshot.nextActions.join(", ")}`
        });
      }
      if (commitmentState.currentObjective !== null) {
        messages.push({
          role: "system",
          content: `Current objective: ${commitmentState.currentObjective.title}`
        });
      }
      if (commitmentState.nextAction !== null) {
        messages.push({
          role: "system",
          content: `Next action: ${commitmentState.nextAction.title} (${commitmentState.nextAction.status})`
        });
      }
      if (commitmentState.pendingDecision !== null) {
        messages.push({
          role: "system",
          content: `Pending decision: ${commitmentState.pendingDecision}`
        });
      }
      messages.push({
        role: "system",
        content: `Active capabilities: ${snapshot.toolCapabilitySummary.join(", ") || "[none]"}`
      });
      const memoryContext = snapshot.activeMemoryIds
        .map((memoryId) => this.dependencies.memoryRepository.findById(memoryId))
        .filter((record): record is NonNullable<typeof record> => record !== null)
        .map((record) => ({
          confidence: record.confidence,
          explanation: "Loaded from latest thread snapshot",
          fragmentId: randomUUID(),
          memoryId: record.memoryId,
          privacyLevel: record.privacyLevel,
          retentionPolicy: record.retentionPolicy,
          scope: record.scope,
          sourceType: record.sourceType,
          status: record.status,
          text: `[${record.scope}] ${record.title}: ${record.summary}`,
          title: record.title
        }));
      return { commitmentState, messages, memoryContext };
    }
    const runs = this.dependencies.threadRunRepository.listByThreadId(threadId);
    const messages: ConversationMessage[] = runs.map((run) => ({
      role: "system",
      content: `ThreadRun#${run.runNumber} status=${run.status} input=${run.input}\nsummary=${JSON.stringify(run.summary)}`
    }));
    return {
      commitmentState,
      messages,
      memoryContext: []
    };
  }
}
