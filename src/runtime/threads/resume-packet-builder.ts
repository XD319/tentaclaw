import { randomUUID } from "node:crypto";

import type { AppConfig } from "../bootstrap.js";
import type {
  ContextFragment,
  JsonObject,
  RuntimeRunOptions,
  ThreadSessionMemoryRecord
} from "../../types/index.js";
import type { ThreadStateProjector } from "./thread-state-projector.js";

export interface ResumePacketBuilderDependencies {
  stateProjector: ThreadStateProjector;
  config: AppConfig;
}

export class ResumePacketBuilder {
  public constructor(private readonly dependencies: ResumePacketBuilderDependencies) {}

  public buildResumePacket(
    threadId: string,
    newInput: string,
    overrides?: Partial<RuntimeRunOptions>
  ): RuntimeRunOptions & { threadId: string } {
    const projection = this.dependencies.stateProjector.projectState(threadId);
    const metadata: JsonObject = {
      ...(overrides?.metadata ?? {}),
      threadResume: {
        blockedReason: projection.commitmentState.blockedReason,
        commitments: projection.commitmentState.openCommitments,
        contextMessages: projection.messages,
        memoryContext: buildThreadResumeMemoryContext(projection.sessionMemory),
        nextAction: projection.commitmentState.nextAction,
        pendingDecision: projection.commitmentState.pendingDecision,
        projectedMessageCount: projection.messages.length,
        sessionMemory: projection.sessionMemory
      } as unknown as JsonObject
    };
    return {
      agentProfileId: overrides?.agentProfileId ?? this.dependencies.config.defaultProfileId,
      cwd: overrides?.cwd ?? this.dependencies.config.workspaceRoot,
      maxIterations: overrides?.maxIterations ?? this.dependencies.config.defaultMaxIterations,
      metadata,
      taskInput: newInput,
      threadId,
      timeoutMs: overrides?.timeoutMs ?? this.dependencies.config.defaultTimeoutMs,
      tokenBudget: overrides?.tokenBudget ?? this.dependencies.config.tokenBudget,
      userId:
        overrides?.userId ?? process.env.USERNAME ?? process.env.USER ?? "local-user"
    };
  }
}

function buildThreadResumeMemoryContext(
  sessionMemory: ThreadSessionMemoryRecord | null
): ContextFragment[] {
  if (sessionMemory === null) {
    return [];
  }

  const fragments: ContextFragment[] = [];
  const trimmedGoal = normalizeSummary(sessionMemory.goal, 220);
  if (trimmedGoal.length > 0) {
    fragments.push(
      createResumeFragment("Thread goal", "thread_resume_goal", trimmedGoal, sessionMemory.createdAt)
    );
  }

  const decisions = dedupeCompact(sessionMemory.decisions, 3, 180);
  if (decisions.length > 0) {
    fragments.push(
      createResumeFragment(
        "Thread decisions",
        "thread_resume_decisions",
        decisions.join(" | "),
        sessionMemory.createdAt
      )
    );
  }

  const openLoops = dedupeCompact(sessionMemory.openLoops, 3, 180);
  if (openLoops.length > 0) {
    fragments.push(
      createResumeFragment(
        "Thread open loops",
        "thread_resume_open_loops",
        openLoops.join(" | "),
        sessionMemory.createdAt
      )
    );
  }

  const nextActions = dedupeCompact(sessionMemory.nextActions, 3, 180);
  if (nextActions.length > 0) {
    fragments.push(
      createResumeFragment(
        "Thread next actions",
        "thread_resume_next_actions",
        nextActions.join(" | "),
        sessionMemory.createdAt
      )
    );
  }

  return fragments;
}

function createResumeFragment(
  title: string,
  memoryIdSuffix: string,
  text: string,
  createdAt: string
): ContextFragment {
  void createdAt;
  return {
    confidence: 0.97,
    explanation: "thread resume packet fragment",
    fragmentId: randomUUID(),
    memoryId: `thread_resume:${memoryIdSuffix}`,
    privacyLevel: "internal",
    retentionPolicy: {
      kind: "working",
      reason: "Thread resume context is injected only for active continuation runs.",
      ttlDays: null
    },
    scope: "working",
    sourceType: "system",
    status: "verified",
    text,
    title
  };
}

function dedupeCompact(values: string[], limit: number, maxLength: number): string[] {
  const unique = new Set<string>();
  const compacted: string[] = [];
  for (const value of values) {
    const normalized = normalizeSummary(value, maxLength);
    if (normalized.length === 0 || unique.has(normalized)) {
      continue;
    }
    unique.add(normalized);
    compacted.push(normalized);
    if (compacted.length >= limit) {
      break;
    }
  }
  return compacted;
}

function normalizeSummary(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  if (compact.length === 0) {
    return "";
  }
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength)}...`;
}
