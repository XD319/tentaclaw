import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ContextPolicy } from "../policy/context-policy";
import type { TraceService } from "../tracing/trace-service";
import type {
  ContextFragment,
  MemoryDraft,
  MemoryQuery,
  MemoryRecallCandidate,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemoryRecord,
  MemoryRepository,
  MemoryReviewRequest,
  MemoryScope,
  MemorySnapshotDiff,
  MemorySnapshotRecord,
  MemorySnapshotRepository,
  SessionCompactInput,
  SessionCompactResult,
  TaskRecord
} from "../types";

const memoryReviewSchema = z.object({
  memoryId: z.string().min(1),
  note: z.string().min(1),
  reviewerId: z.string().min(1),
  status: z.enum(["verified", "rejected", "stale"])
});

export interface MemoryPlaneDependencies {
  contextPolicy: ContextPolicy;
  memoryRepository: MemoryRepository;
  memorySnapshotRepository: MemorySnapshotRepository;
  traceService: TraceService;
}

export interface BuildContextResult {
  recall: MemoryRecallResult;
  fragments: ContextFragment[];
}

export class MemoryPlane {
  public constructor(private readonly dependencies: MemoryPlaneDependencies) {}

  public buildContext(task: TaskRecord): BuildContextResult {
    this.ageExpiredMemories();

    const recall = this.recall({
      agentScopeKey: createAgentScopeKey(task),
      limit: 6,
      projectScopeKey: task.cwd,
      query: task.input,
      sessionScopeKey: task.taskId,
      taskId: task.taskId
    });

    this.dependencies.traceService.record({
      actor: "memory.plane",
      eventType: "memory_recalled",
      payload: {
        blockedMemoryIds: recall.decisions
          .filter((decision) => !decision.allowed)
          .map((decision) => decision.fragment.memoryId),
        query: recall.query,
        selectedMemoryIds: recall.selectedFragments.map((fragment) => fragment.memoryId),
        selectedScopes: recall.selectedFragments.map((fragment) => fragment.scope)
      },
      stage: "memory",
      summary: `Selective recall returned ${recall.selectedFragments.length} memory fragments`,
      taskId: task.taskId
    });

    return {
      fragments: recall.selectedFragments,
      recall
    };
  }

  public rememberTaskGoal(task: TaskRecord): MemoryRecord {
    return this.persistMemory({
      confidence: 0.95,
      content: task.input,
      expiresAt: null,
      keywords: tokenize(task.input),
      privacyLevel: "internal",
      retentionPolicy: {
        kind: "session",
        reason: "Task goal should stay available during the active session.",
        ttlDays: null
      },
      scope: "session",
      scopeKey: task.taskId,
      source: {
        label: `Task goal for ${task.taskId}`,
        sourceType: "user_input",
        taskId: task.taskId,
        toolCallId: null,
        traceEventId: null
      },
      status: "verified",
      summary: summarize(task.input),
      title: "Task goal"
    });
  }

  public recordToolOutcome(input: {
    output: string;
    privacyLevel: MemoryRecord["privacyLevel"];
    summary: string;
    task: TaskRecord;
    toolCallId: string;
    toolName: string;
  }): MemoryRecord | null {
    return this.persistMemoryIfAllowed({
      confidence: 0.72,
      content: input.output,
      expiresAt: null,
      keywords: tokenize(`${input.toolName} ${input.summary} ${input.output}`),
      privacyLevel: input.privacyLevel,
      retentionPolicy: {
        kind: "session",
        reason: "Tool outcomes are retained only for the active session by default.",
        ttlDays: null
      },
      scope: "session",
      scopeKey: input.task.taskId,
      source: {
        label: `Tool output from ${input.toolName}`,
        sourceType: "tool_output",
        taskId: input.task.taskId,
        toolCallId: input.toolCallId,
        traceEventId: null
      },
      status: "candidate",
      summary: input.summary,
      title: `Tool result: ${input.toolName}`
    });
  }

  public recordFinalOutcome(task: TaskRecord, output: string): MemoryRecord[] {
    const baseDraft = {
      confidence: 0.78,
      content: output,
      expiresAt: null,
      keywords: tokenize(output),
      privacyLevel: "internal" as const,
      retentionPolicy: {
        kind: "project" as const,
        reason: "Successful task results can seed project and agent memory.",
        ttlDays: 30
      },
      source: {
        label: `Final outcome for ${task.taskId}`,
        sourceType: "final_output" as const,
        taskId: task.taskId,
        toolCallId: null,
        traceEventId: null
      },
      status: "candidate" as const,
      summary: summarize(output),
      title: "Task outcome"
    };

    const persisted: MemoryRecord[] = [];
    const projectMemory = this.persistMemoryIfAllowed({
      ...baseDraft,
      retentionPolicy: {
        kind: "project",
        reason: "Project memory keeps reusable task outcomes for the current workspace.",
        ttlDays: 30
      },
      scope: "project",
      scopeKey: task.cwd
    });
    if (projectMemory !== null) {
      persisted.push(projectMemory);
    }

    const agentMemory = this.persistMemoryIfAllowed({
      ...baseDraft,
      retentionPolicy: {
        kind: "agent",
        reason: "Agent memory keeps reusable behavior hints per user/profile.",
        ttlDays: 30
      },
      scope: "agent",
      scopeKey: createAgentScopeKey(task)
    });
    if (agentMemory !== null) {
      persisted.push(agentMemory);
    }

    return persisted;
  }

  public compactSession(input: SessionCompactInput): SessionCompactResult {
    if (input.messages.length < input.maxMessagesBeforeCompact) {
      return {
        reason: null,
        replacementMessages: input.messages.map((message) => ({
          content: message.content,
          role: toConversationRole(message.role)
        })),
        summaryMemory: null,
        triggered: false
      };
    }

    const summary = summarizeMessages(input.messages);
    const summaryMemory = this.persistMemory({
      confidence: 0.88,
      content: summary,
      expiresAt: null,
      keywords: tokenize(summary),
      privacyLevel: "internal",
      retentionPolicy: {
        kind: "session",
        reason: "Compacted session summaries preserve the active task thread.",
        ttlDays: null
      },
      scope: "session",
      scopeKey: input.sessionScopeKey,
      source: {
        label: `Session compact for ${input.taskId}`,
        sourceType: "session_compact",
        taskId: input.taskId,
        toolCallId: null,
        traceEventId: null
      },
      status: "verified",
      summary,
      title: "Session compact"
    });

    this.dependencies.traceService.record({
      actor: "memory.plane",
      eventType: "session_compacted",
      payload: {
        reason: "message_count",
        replacedMessageCount: input.messages.length - 2,
        summaryMemoryId: summaryMemory.memoryId
      },
      stage: "memory",
      summary: "Session messages compacted into a typed memory summary",
      taskId: input.taskId
    });

    const preserved = input.messages.slice(-2).map((message) => ({
      content: message.content,
      role: toConversationRole(message.role)
    }));

    return {
      reason: "message_count",
      replacementMessages: [
        {
          content: `Session summary:\n${summary}`,
          role: "system"
        },
        ...preserved
      ],
      summaryMemory,
      triggered: true
    };
  }

  public list(query?: MemoryQuery): MemoryRecord[] {
    this.ageExpiredMemories();
    return this.dependencies.memoryRepository.list(query);
  }

  public writeMemory(record: MemoryDraft): MemoryRecord | null {
    return this.persistMemoryIfAllowed(record);
  }

  public showScope(scope: MemoryScope, scopeKey: string): {
    memories: MemoryRecord[];
    snapshots: MemorySnapshotRecord[];
  } {
    return {
      memories: this.list({
        includeExpired: true,
        includeRejected: true,
        scope,
        scopeKey
      }),
      snapshots: this.dependencies.memorySnapshotRepository.listByScope(scope, scopeKey)
    };
  }

  public reviewMemory(request: MemoryReviewRequest): MemoryRecord {
    const parsed = memoryReviewSchema.parse(request);
    const current = this.dependencies.memoryRepository.findById(parsed.memoryId);
    if (current === null) {
      throw new Error(`Memory ${parsed.memoryId} was not found.`);
    }

    return this.dependencies.memoryRepository.update(parsed.memoryId, {
      confidence:
        parsed.status === "verified"
          ? Math.max(current.confidence, 0.9)
          : parsed.status === "rejected"
            ? Math.min(current.confidence, 0.1)
            : Math.min(current.confidence, 0.4),
      lastVerifiedAt:
        parsed.status === "verified" ? new Date().toISOString() : current.lastVerifiedAt,
      metadata: {
        ...current.metadata,
        reviewNote: parsed.note,
        reviewedBy: parsed.reviewerId
      },
      status: parsed.status
    });
  }

  public createSnapshot(input: {
    createdBy: string;
    label: string;
    scope: MemoryScope;
    scopeKey: string;
  }): MemorySnapshotRecord {
    const memories = this.list({
      includeExpired: true,
      includeRejected: true,
      scope: input.scope,
      scopeKey: input.scopeKey
    });
    const snapshot = this.dependencies.memorySnapshotRepository.create({
      createdBy: input.createdBy,
      label: input.label,
      memoryIds: memories.map((memory) => memory.memoryId),
      metadata: {
        memoryCount: memories.length
      },
      scope: input.scope,
      scopeKey: input.scopeKey,
      summary: `Snapshot of ${input.scope} memory with ${memories.length} records`
    });

    this.dependencies.traceService.record({
      actor: `reviewer.${input.createdBy}`,
      eventType: "memory_snapshot_created",
      payload: {
        memoryCount: memories.length,
        scope: input.scope,
        scopeKey: input.scopeKey,
        snapshotId: snapshot.snapshotId
      },
      stage: "memory",
      summary: `Snapshot ${snapshot.label} created`,
      taskId: "memory-admin"
    });

    return snapshot;
  }

  public compareSnapshot(snapshotId: string): MemorySnapshotDiff | null {
    const current = this.dependencies.memorySnapshotRepository.findById(snapshotId);
    if (current === null) {
      return null;
    }

    const latest = this.dependencies.memorySnapshotRepository.listByScope(current.scope, current.scopeKey)[0];
    if (latest === undefined) {
      return null;
    }

    return {
      addedMemoryIds: latest.memoryIds.filter((memoryId) => !current.memoryIds.includes(memoryId)),
      removedMemoryIds: current.memoryIds.filter((memoryId) => !latest.memoryIds.includes(memoryId)),
      snapshotId
    };
  }

  private recall(request: MemoryRecallRequest): MemoryRecallResult {
    const queryTokens = tokenize(request.query);
    const candidates = [
      ...this.dependencies.memoryRepository.list({
        includeExpired: false,
        limit: request.limit * 3,
        scope: "session",
        scopeKey: request.sessionScopeKey
      }),
      ...this.dependencies.memoryRepository.list({
        includeExpired: false,
        limit: request.limit * 3,
        scope: "project",
        scopeKey: request.projectScopeKey
      }),
      ...this.dependencies.memoryRepository.list({
        includeExpired: false,
        limit: request.limit * 3,
        scope: "agent",
        scopeKey: request.agentScopeKey
      })
    ]
      .map((memory) => scoreMemory(memory, queryTokens))
      .filter((candidate) => candidate.finalScore > 0)
      .sort((left, right) => right.finalScore - left.finalScore)
      .slice(0, request.limit);

    const fragments = candidates.map((candidate) => candidateToFragment(candidate));
    const filtered = this.dependencies.contextPolicy.filterForModelContext({
      fragments
    });

    return {
      candidates,
      decisions: filtered.decisions,
      query: request.query,
      selectedFragments: filtered.allowedFragments
    };
  }

  private persistMemoryIfAllowed(record: MemoryDraft): MemoryRecord | null {
    if (record.scope !== "session") {
      const decision = this.dependencies.contextPolicy.decideLongTermWrite({
        content: record.content,
        privacyLevel: record.privacyLevel,
        scope: record.scope,
        sourceLabel: record.source.label
      });
      if (!decision.allowed) {
        return null;
      }
    }

    return this.persistMemory(record);
  }

  private persistMemory(record: MemoryDraft): MemoryRecord {
    const normalized = {
      ...record,
      conflictsWith: record.conflictsWith ?? [],
      keywords: uniqueStrings(record.keywords),
      metadata: record.metadata ?? {},
      summary: summarize(record.summary),
      title: summarize(record.title, 80)
    };
    const conflictIds = this.findConflicts(normalized.scope, normalized.scopeKey, normalized);
    const persisted = this.dependencies.memoryRepository.create({
      ...normalized,
      conflictsWith: uniqueStrings([...normalized.conflictsWith, ...conflictIds])
    });

    for (const conflictId of conflictIds) {
      const conflict = this.dependencies.memoryRepository.findById(conflictId);
      if (conflict === null) {
        continue;
      }

      this.dependencies.memoryRepository.update(conflictId, {
        conflictsWith: uniqueStrings([...conflict.conflictsWith, persisted.memoryId])
      });
    }

    this.dependencies.traceService.record({
      actor: "memory.plane",
      eventType: "memory_written",
      payload: {
        memoryId: persisted.memoryId,
        privacyLevel: persisted.privacyLevel,
        scope: persisted.scope,
        sourceType: persisted.sourceType,
        status: persisted.status
      },
      stage: "memory",
      summary: `Memory ${persisted.memoryId} persisted in ${persisted.scope} scope`,
      taskId: persisted.source.taskId ?? "memory-admin"
    });

    return persisted;
  }

  private ageExpiredMemories(): void {
    const now = new Date().toISOString();
    for (const memory of this.dependencies.memoryRepository.list({
      includeExpired: true,
      includeRejected: true
    })) {
      if (memory.expiresAt !== null && memory.expiresAt <= now && memory.status !== "rejected") {
        this.dependencies.memoryRepository.update(memory.memoryId, {
          status: "stale"
        });
      }
    }
  }

  private findConflicts(
    scope: MemoryScope,
    scopeKey: string,
    draft: Pick<MemoryDraft, "content" | "keywords" | "summary">
  ): string[] {
    return this.dependencies.memoryRepository
      .list({
        includeExpired: true,
        includeRejected: false,
        scope,
        scopeKey
      })
      .filter((memory) => {
        const overlap = overlapRatio(memory.keywords, draft.keywords);
        return overlap >= 0.5 && memory.content !== draft.content && memory.summary !== draft.summary;
      })
      .map((memory) => memory.memoryId);
  }
}

export function createAgentScopeKey(task: Pick<TaskRecord, "agentProfileId" | "requesterUserId">): string {
  return `${task.requesterUserId}:${task.agentProfileId}`;
}

function scoreMemory(memory: MemoryRecord, queryTokens: string[]): MemoryRecallCandidate {
  const keywordScore = overlapRatio(memory.keywords, queryTokens);
  const freshnessScore = memory.status === "stale" ? 0.2 : memory.status === "candidate" ? 0.7 : 1;
  const confidenceScore = memory.confidence;
  const finalScore = Number((keywordScore * 0.45 + freshnessScore * 0.2 + confidenceScore * 0.35).toFixed(4));

  return {
    confidenceScore,
    explanation: `scope=${memory.scope}; keyword=${keywordScore.toFixed(2)}; freshness=${freshnessScore.toFixed(2)}; confidence=${confidenceScore.toFixed(2)}; source=${memory.source.label}`,
    finalScore,
    freshnessScore,
    keywordScore,
    memory
  };
}

function candidateToFragment(candidate: MemoryRecallCandidate): ContextFragment {
  return {
    confidence: candidate.memory.confidence,
    explanation: `${candidate.explanation}; source=${candidate.memory.source.label}`,
    fragmentId: randomUUID(),
    memoryId: candidate.memory.memoryId,
    privacyLevel: candidate.memory.privacyLevel,
    retentionPolicy: candidate.memory.retentionPolicy,
    scope: candidate.memory.scope,
    sourceType: candidate.memory.sourceType,
    status: candidate.memory.status,
    text: `[${candidate.memory.scope}] ${candidate.memory.title}: ${candidate.memory.summary}`,
    title: candidate.memory.title
  };
}

function overlapRatio(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const rightSet = new Set(right);
  const overlap = uniqueStrings(left).filter((token) => rightSet.has(token)).length;
  return overlap / Math.max(1, Math.min(uniqueStrings(left).length, rightSet.size));
}

function tokenize(value: string): string[] {
  return uniqueStrings(
    value
      .toLowerCase()
      .split(/[^a-z0-9_\u4e00-\u9fa5]+/u)
      .filter((token) => token.length >= 2)
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function summarize(value: string, maxLength = 160): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength)}...`;
}

function summarizeMessages(messages: SessionCompactInput["messages"]): string {
  const important = messages
    .filter((message) => message.role !== "system")
    .map((message) => `${message.role}: ${summarize(message.content, 120)}`);

  return summarize(important.join(" | "), 600);
}

function toConversationRole(role: string): "assistant" | "system" | "tool" | "user" {
  return role === "assistant" || role === "system" || role === "tool" || role === "user"
    ? role
    : "system";
}
