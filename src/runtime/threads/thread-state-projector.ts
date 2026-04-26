import type {
  ConversationMessage,
  ThreadCommitmentState,
  ThreadSessionMemoryRecord
} from "../../types/index.js";
import type { ThreadSessionMemoryService } from "../context/thread-session-memory-service.js";
import type { ThreadCommitmentProjector } from "../commitments/thread-commitment-projector.js";

export interface ThreadStateProjection {
  messages: ConversationMessage[];
  commitmentState: ThreadCommitmentState;
  sessionMemory: ThreadSessionMemoryRecord | null;
}

export interface ThreadStateProjectorDependencies {
  threadSessionMemoryService: ThreadSessionMemoryService;
  commitmentProjector: ThreadCommitmentProjector;
}

export class ThreadStateProjector {
  public constructor(private readonly dependencies: ThreadStateProjectorDependencies) {}

  public projectState(threadId: string): ThreadStateProjection {
    const commitmentState = this.dependencies.commitmentProjector.project(threadId);
    const sessionMemory = this.dependencies.threadSessionMemoryService.findLatestByThread(threadId);
    if (sessionMemory !== null) {
      const messages = toResumeMessages(sessionMemory, commitmentState);
      return {
        commitmentState,
        messages,
        sessionMemory
      };
    }
    return {
      commitmentState,
      messages: [],
      sessionMemory: null
    };
  }
}

function toResumeMessages(
  sessionMemory: ThreadSessionMemoryRecord,
  commitmentState: ThreadCommitmentState
): ConversationMessage[] {
  const messages: ConversationMessage[] = [
    {
      role: "system",
      content: `KnownThreadGoal: ${normalizeLine(sessionMemory.goal, 220)}`
    }
  ];
  const decisions = compactItems(sessionMemory.decisions, 3, 180);
  if (decisions.length > 0) {
    messages.push({
      role: "system",
      content: `KnownDecisions: ${decisions.join(" | ")}`
    });
  }
  const openLoops = compactItems(sessionMemory.openLoops, 3, 180);
  if (openLoops.length > 0) {
    messages.push({
      role: "system",
      content: `KnownOpenLoops: ${openLoops.join(" | ")}`
    });
  }
  const nextActions = compactItems(sessionMemory.nextActions, 3, 180);
  if (nextActions.length > 0) {
    messages.push({
      role: "system",
      content: `KnownNextActions: ${nextActions.join(" | ")}`
    });
  }
  if (commitmentState.currentObjective !== null) {
    messages.push({
      role: "system",
      content: `KnownCurrentObjective: ${normalizeLine(commitmentState.currentObjective.title, 180)}`
    });
  }
  if (commitmentState.nextAction !== null) {
    messages.push({
      role: "system",
      content: `KnownPlannedNextAction: ${normalizeLine(
        `${commitmentState.nextAction.title} (${commitmentState.nextAction.status})`,
        180
      )}`
    });
  }
  if (commitmentState.pendingDecision !== null) {
    messages.push({
      role: "system",
      content: `KnownPendingDecision: ${normalizeLine(commitmentState.pendingDecision, 180)}`
    });
  }
  return messages;
}

function compactItems(values: string[], limit: number, maxLength: number): string[] {
  const unique = new Set<string>();
  const items: string[] = [];
  for (const value of values) {
    const compact = normalizeLine(value, maxLength);
    if (compact.length === 0 || unique.has(compact)) {
      continue;
    }
    unique.add(compact);
    items.push(compact);
    if (items.length >= limit) {
      break;
    }
  }
  return items;
}

function normalizeLine(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  if (compact.length === 0) {
    return "";
  }
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength)}...`;
}
