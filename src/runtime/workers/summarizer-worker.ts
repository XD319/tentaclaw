import type { ContextCompactor, SessionSnapshotService } from "../context/index.js";
import type { FocusState } from "../focus-state.js";
import type {
  ContextFragment,
  ProviderToolDescriptor,
  SessionCompactInput,
  SessionCompactResult,
  TaskRecord,
  ThreadSnapshotRecord
} from "../../types/index.js";

export interface SummarizerWorkerDependencies {
  contextCompactor: ContextCompactor;
  sessionSnapshotService: SessionSnapshotService;
}

export interface SummarizerWorkerInput {
  compactResult: SessionCompactResult;
  compactInput: SessionCompactInput & {
    reason: "message_count" | "context_budget" | "token_budget" | "tool_call_count";
  };
  task: TaskRecord;
  focusState?: FocusState;
  memoryContext: ContextFragment[];
  availableTools: ProviderToolDescriptor[];
  runId: string | null;
}

export interface SummarizerWorkerOutput {
  snapshot: ThreadSnapshotRecord | null;
  compacted: boolean;
  summary: string;
}

export class SummarizerWorker {
  public constructor(private readonly dependencies: SummarizerWorkerDependencies) {}

  public execute(input: SummarizerWorkerInput): Promise<SummarizerWorkerOutput> {
    if (!input.compactResult.triggered || input.task.threadId === null || input.task.threadId === undefined) {
      return Promise.resolve({
        compacted: input.compactResult.triggered,
        snapshot: null,
        summary: "Compaction did not produce a thread snapshot."
      });
    }

    const snapshotDraft = this.dependencies.contextCompactor.buildSnapshot({
      availableTools: input.availableTools,
      compact: input.compactInput,
      ...(input.focusState !== undefined ? { focusState: input.focusState } : {}),
      memoryContext: input.memoryContext,
      task: input.task
    });
    const snapshot = this.dependencies.sessionSnapshotService.createSnapshot({
      ...snapshotDraft,
      runId: input.runId,
      threadId: input.task.threadId,
      trigger: "compact"
    });
    return Promise.resolve({
      compacted: true,
      snapshot,
      summary: snapshot.summary
    });
  }
}
