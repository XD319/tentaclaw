import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ContextPolicy } from "../policy/context-policy.js";
import { RecallEngine, overlapRatio, tokenize, uniqueStrings } from "../recall/recall-engine.js";
import type { TraceService } from "../tracing/trace-service.js";
import { CompactTriggerPolicy } from "./compact-policy.js";
import { DeterministicCompactSummarizer, type CompactSummarizer } from "./compact-summarizer.js";
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
} from "../types/index.js";

const memoryReviewSchema = z.object({
  memoryId: z.string().min(1),
  note: z.string().min(1),
  reviewerId: z.string().min(1),
  status: z.enum(["verified", "rejected", "stale"])
});

export interface MemoryPlaneDependencies {
  compactPolicy?: CompactTriggerPolicy;
  compactSummarizer?: CompactSummarizer;
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
  private readonly recallEngine = new RecallEngine();
  private readonly compactPolicy: CompactTriggerPolicy;
  private readonly compactSummarizer: CompactSummarizer;

  public constructor(private readonly dependencies: MemoryPlaneDependencies) {
    this.compactPolicy = dependencies.compactPolicy ?? new CompactTriggerPolicy();
    this.compactSummarizer = dependencies.compactSummarizer ?? new DeterministicCompactSummarizer();
  }

  public buildContext(task: TaskRecord): BuildContextResult {
    this.ageExpiredMemories();

    const recall = this.recall({
      profileScopeKey: createProfileScopeKey(task),
      limit: 6,
      projectScopeKey: task.cwd,
      query: task.input,
      workingScopeKey: task.taskId,
      taskId: task.taskId
    });

    this.dependencies.traceService.record({
      actor: "memory.plane",
      eventType: "memory_recalled",
      payload: {
        blockedMemoryIds: recall.decisions
          .filter((decision) => !decision.allowed)
          .map((decision) => decision.fragment.memoryId),
        entries: recall.candidates.map((candidate) => {
          const decision =
            recall.decisions.find((item) => item.fragment.memoryId === candidate.memory.memoryId) ??
            null;
          return {
            blocked: decision?.allowed === false,
            confidence: candidate.memory.confidence,
            downrankReasons: candidate.downrankReasons,
            explanation: candidate.explanation,
            filterReason: decision?.allowed === false ? decision.reason : null,
            filterReasonCode: decision?.allowed === false ? decision.reasonCode : null,
            memoryId: candidate.memory.memoryId,
            privacyLevel: candidate.memory.privacyLevel,
            retentionPolicyKind: candidate.memory.retentionPolicy.kind,
            selected: recall.selectedFragments.some(
              (fragment) => fragment.memoryId === candidate.memory.memoryId
            ),
            sourceType: candidate.memory.sourceType,
            status: candidate.memory.status,
            title: candidate.memory.title
          };
        }),
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
        kind: "working",
        reason: "Task goal should stay available during the active session.",
        ttlDays: null
      },
      scope: "working",
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
        kind: "working",
        reason: "Tool outcomes are retained only for the active session by default.",
        ttlDays: null
      },
      scope: "working",
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
    void task;
    void output;
    return [];
  }

  public async compactSession(input: SessionCompactInput): Promise<SessionCompactResult> {
    const decision = this.compactPolicy.shouldCompact(input);
    if (!decision.triggered) {
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

    const summarized = await this.compactSummarizer.summarize(input);
    const summary = summarized.summary;
    const summaryMemory = this.persistMemory({
      confidence: 0.88,
      content: summary,
      expiresAt: null,
      keywords: tokenize(summary),
      privacyLevel: "internal",
      retentionPolicy: {
        kind: "working",
        reason: "Compacted session summaries preserve the active task thread.",
        ttlDays: null
      },
      scope: "working",
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

    const compactReason =
      decision.reason === "token_budget" || decision.reason === "tool_call_count"
        ? decision.reason
        : "message_count";
    this.dependencies.traceService.record({
      actor: "memory.plane",
      eventType: "session_compacted",
      payload: {
        reason: compactReason,
        replacedMessageCount: input.messages.length - 3,
        summaryMemoryId: summaryMemory.memoryId,
        summarizerId: summarized.summarizerId
      },
      stage: "memory",
      summary: "Session messages compacted into a typed memory summary",
      taskId: input.taskId
    });

    const preserved = input.messages.slice(-3).map((message) => ({
      content: message.content,
      role: toConversationRole(message.role)
    }));

    return {
      reason: compactReason,
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
    const candidates = [
      ...this.dependencies.memoryRepository.list({
        includeExpired: false,
        limit: request.limit * 3,
        scope: "working",
        scopeKey: request.workingScopeKey
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
        scope: "profile",
        scopeKey: request.profileScopeKey
      })
    ];
    const rankedCandidates = this.recallEngine.rankMemory(candidates, request.query, request.limit);

    const fragments = rankedCandidates.map((candidate) => candidateToFragment(candidate));
    const filtered = this.dependencies.contextPolicy.filterForModelContext({
      fragments
    });

    return {
      candidates: rankedCandidates,
      decisions: filtered.decisions,
      query: request.query,
      selectedFragments: filtered.allowedFragments
    };
  }

  private persistMemoryIfAllowed(record: MemoryDraft): MemoryRecord | null {
    if (record.scope !== "working") {
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

export function createProfileScopeKey(task: Pick<TaskRecord, "agentProfileId" | "requesterUserId">): string {
  return `${task.requesterUserId}:${task.agentProfileId}`;
}

/** @deprecated use createProfileScopeKey */
export const createAgentScopeKey = createProfileScopeKey;

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

function summarize(value: string, maxLength = 160): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength)}...`;
}

function toConversationRole(role: string): "assistant" | "system" | "tool" | "user" {
  return role === "assistant" || role === "system" || role === "tool" || role === "user"
    ? role
    : "system";
}
