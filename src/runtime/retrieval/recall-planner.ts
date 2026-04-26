import { randomUUID } from "node:crypto";

import type { ExperiencePlane } from "../../experience/experience-plane.js";
import { createProfileScopeKey } from "../../memory/memory-plane.js";
import type { SkillContextService } from "../../skills/index.js";
import type {
  ContextFragment,
  MemoryRecallCandidate,
  MemoryRecallResult,
  RecallExplainPayload,
  TaskRecord,
  ThreadSessionMemoryRecord,
  ThreadCommitmentState,
  TokenBudget
} from "../../types/index.js";
import type { TraceService } from "../../tracing/trace-service.js";
import { MemorySelector, type ScoredRecallCandidate } from "./memory-selector.js";
import type { RecallBudgetPolicy } from "./recall-budget-policy.js";

export interface RecallPlannerDependencies {
  experiencePlane: ExperiencePlane;
  memoryPlane: {
    recall: (request: {
      taskId: string;
      query: string;
      projectScopeKey: string;
      profileScopeKey: string;
      limit: number;
    }) => MemoryRecallResult;
    recordRecall: (taskId: string, recall: MemoryRecallResult) => void;
  };
  sessionSearchService?: {
    searchAsContext: (input: { limit: number; query: string; threadId: string }) => ContextFragment[];
    searchGlobalAsContext: (input: {
      limit: number;
      query: string;
      excludeThreadId?: string | null;
    }) => ContextFragment[];
  };
  skillContextService: SkillContextService;
  traceService: TraceService;
  budgetPolicy: RecallBudgetPolicy;
  enabled: boolean;
  maxCandidatesPerScope: number;
}

export interface RecallPlanningInput {
  task: TaskRecord;
  tokenBudget: TokenBudget;
  threadCommitmentState?: ThreadCommitmentState | null;
  toolPlan?: string[];
}

export interface RecallPlanResult {
  fragments: ContextFragment[];
  explain: RecallExplainPayload;
}

export class RecallPlanner {
  private readonly selector = new MemorySelector();

  public constructor(private readonly dependencies: RecallPlannerDependencies) {}

  public plan(input: RecallPlanningInput): RecallPlanResult {
    if (!this.dependencies.enabled) {
      return this.planLegacy(input);
    }
    const enrichedQuery = buildEnrichedQuery(input.task, input.threadCommitmentState, input.toolPlan);
    const budget = this.dependencies.budgetPolicy.computeBudget(input.tokenBudget);
    const memoryRecall = this.dependencies.memoryPlane.recall({
      limit: this.dependencies.maxCandidatesPerScope,
      profileScopeKey: createProfileScopeKey(input.task),
      projectScopeKey: input.task.cwd,
      query: enrichedQuery,
      taskId: input.task.taskId
    });
    this.dependencies.memoryPlane.recordRecall(input.task.taskId, memoryRecall);
    const memoryDecisionById = new Map(
      memoryRecall.decisions.map((decision) => [decision.fragment.memoryId, decision] as const)
    );
    const memoryCandidates = memoryRecall.candidates.map((candidate) =>
      toMemoryCandidate(candidate, memoryDecisionById.get(candidate.memory.memoryId)?.allowed !== false)
    );

    const experienceCandidates = this.dependencies.experiencePlane
      .recallExperiences(enrichedQuery, {
        limit: this.dependencies.maxCandidatesPerScope,
        taskId: input.task.taskId
      })
      .map((candidate) => toExperienceCandidate(candidate));

    const skillCandidates = this.dependencies.skillContextService
      .rankSkills({
        cwd: input.task.cwd,
        input: enrichedQuery
      })
      .slice(0, this.dependencies.maxCandidatesPerScope)
      .map((candidate) => toSkillCandidate(candidate.metadata, candidate.score));

    const threadId = input.task.threadId;
    const sessionFragments =
      threadId === null || threadId === undefined
        ? []
        : this.dependencies.sessionSearchService
            ?.searchAsContext({
              limit: this.dependencies.maxCandidatesPerScope,
              query: enrichedQuery,
              threadId
            })
            ?? [];
    const globalSessionFragments =
      this.dependencies.sessionSearchService === undefined || !hasHistoricalRecallSignal(enrichedQuery)
        ? []
        : this.dependencies.sessionSearchService.searchGlobalAsContext({
            excludeThreadId: threadId ?? null,
            limit: this.dependencies.maxCandidatesPerScope,
            query: enrichedQuery
          });
    const threadLocalSessionCandidates = sessionFragments.map((fragment) =>
      toSessionCandidate(fragment, {
        scoreBoost: 0.35,
        source: "thread_local"
      })
    );
    const globalSessionCandidates = globalSessionFragments.map((fragment) =>
      toSessionCandidate(fragment, {
        scoreBoost: 0.1,
        source: "global"
      })
    );
    const allCandidates = [
      ...memoryCandidates,
      ...experienceCandidates,
      ...skillCandidates,
      ...threadLocalSessionCandidates,
      ...globalSessionCandidates
    ];
    const reservedThreadLocal = reserveThreadLocalCandidates(
      threadLocalSessionCandidates,
      budget.totalTokenBudget,
      2
    );
    const reservedIds = new Set(reservedThreadLocal.selected.map((item) => item.id));
    const remainingCandidates = allCandidates.filter((candidate) => !reservedIds.has(candidate.id));
    const remainingSelection = this.selector.select(remainingCandidates, {
      scopeWeights: budget.scopeWeights,
      tokenBudget: Math.max(0, budget.totalTokenBudget - reservedThreadLocal.tokenUsed)
    });
    const selection = {
      selected: [...reservedThreadLocal.selected, ...remainingSelection.selected],
      selectedFragments: [
        ...reservedThreadLocal.selectedFragments,
        ...remainingSelection.selectedFragments
      ],
      skipped: [...reservedThreadLocal.skipped, ...remainingSelection.skipped],
      tokenUsed: reservedThreadLocal.tokenUsed + remainingSelection.tokenUsed
    };

    const explain: RecallExplainPayload = {
      candidateCount:
        memoryCandidates.length +
        experienceCandidates.length +
        skillCandidates.length +
        threadLocalSessionCandidates.length +
        globalSessionCandidates.length,
      enrichedQuery,
      items: [...selection.selected, ...selection.skipped].map((item) => ({
        id: item.id,
        reason: item.reason,
        scope: item.scope,
        score: item.score,
        selected: item.selected,
        tokenEstimate: item.tokenEstimate
      })),
      selectedCount: selection.selected.length,
      skippedCount: selection.skipped.length,
      tokenBudget: budget.totalTokenBudget,
      tokenUsed: selection.tokenUsed
    };

    this.dependencies.traceService.record({
      actor: "runtime.recall",
      eventType: "recall_explain",
      payload: explain,
      stage: "memory",
      summary: `Recall selected ${selection.selected.length}/${explain.candidateCount} items`,
      taskId: input.task.taskId
    });

    return {
      explain,
      fragments: selection.selectedFragments
    };
  }

  private planLegacy(input: RecallPlanningInput): RecallPlanResult {
    const memoryRecall = this.dependencies.memoryPlane.recall({
      limit: 6,
      profileScopeKey: createProfileScopeKey(input.task),
      projectScopeKey: input.task.cwd,
      query: input.task.input,
      taskId: input.task.taskId
    });
    this.dependencies.memoryPlane.recordRecall(input.task.taskId, memoryRecall);
    const skillFragments = this.dependencies.skillContextService.buildContext(input.task);
    const threadId = input.task.threadId;
    const localSessionFragments =
      threadId === null || threadId === undefined
        ? []
        : this.dependencies.sessionSearchService?.searchAsContext({
            limit: 3,
            query: input.task.input,
            threadId
          }) ?? [];
    const globalSessionFragments =
      this.dependencies.sessionSearchService === undefined || !hasHistoricalRecallSignal(input.task.input)
        ? []
        : this.dependencies.sessionSearchService.searchGlobalAsContext({
            excludeThreadId: threadId ?? null,
            limit: 3,
            query: input.task.input
          });
    const fragments = [
      ...memoryRecall.selectedFragments,
      ...skillFragments,
      ...localSessionFragments,
      ...globalSessionFragments
    ];
    const explain: RecallExplainPayload = {
      candidateCount: fragments.length,
      enrichedQuery: input.task.input,
      items: fragments.map((fragment) => ({
        id: fragment.memoryId,
        reason: "legacy_recall_enabled_false",
        scope: fragment.scope,
        score: Number(fragment.confidence.toFixed(4)),
        selected: true,
        tokenEstimate: estimateTokens(fragment.text)
      })),
      selectedCount: fragments.length,
      skippedCount: 0,
      tokenBudget: Number.MAX_SAFE_INTEGER,
      tokenUsed: fragments.reduce((total, fragment) => total + estimateTokens(fragment.text), 0)
    };
    this.dependencies.traceService.record({
      actor: "runtime.recall",
      eventType: "recall_explain",
      payload: explain,
      stage: "memory",
      summary: `Recall fallback selected ${fragments.length} items`,
      taskId: input.task.taskId
    });
    return { explain, fragments };
  }
}

function toMemoryCandidate(candidate: MemoryRecallCandidate, policyAllowed: boolean): ScoredRecallCandidate {
  const fragment = {
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
  } satisfies ContextFragment;

  return {
    fragment,
    id: candidate.memory.memoryId,
    reason: `${candidate.explanation}; policyAllowed=${policyAllowed}`,
    score: candidate.finalScore,
    scope: candidate.memory.scope,
    tokenEstimate: estimateTokens(fragment.text)
  };
}

function toExperienceCandidate(
  candidate: ReturnType<ExperiencePlane["recallExperiences"]>[number]
): ScoredRecallCandidate {
  const fragment = {
    confidence: candidate.finalScore,
    explanation: candidate.explanation,
    fragmentId: randomUUID(),
    memoryId: `experience:${candidate.experience.experienceId}`,
    privacyLevel: "internal",
    retentionPolicy: {
      kind: "working",
      reason: "Experience references are loaded for the active task only.",
      ttlDays: null
    },
    scope: "experience_ref",
    sourceType: "system",
    status: "verified",
    text: [
      `Experience reference ${candidate.experience.experienceId}`,
      `title=${candidate.experience.title}`,
      `summary=${candidate.experience.summary}`,
      `type=${candidate.experience.type}`,
      `status=${candidate.experience.status}`
    ].join("\n"),
    title: `Experience ${candidate.experience.experienceId}`
  } satisfies ContextFragment;

  return {
    fragment,
    id: candidate.experience.experienceId,
    reason: candidate.explanation,
    score: candidate.finalScore,
    scope: "experience_ref",
    tokenEstimate: estimateTokens(fragment.text)
  };
}

function toSkillCandidate(
  metadata: ReturnType<SkillContextService["rankSkills"]>[number]["metadata"],
  score: number
): ScoredRecallCandidate {
  const fragment = {
    confidence: Number(score.toFixed(4)),
    explanation: `skill metadata matched recall query with score=${score.toFixed(2)}`,
    fragmentId: randomUUID(),
    memoryId: `skill:${metadata.id}`,
    privacyLevel: "internal",
    retentionPolicy: {
      kind: "working",
      reason: "Skill references are loaded for the active task only.",
      ttlDays: null
    },
    scope: "skill_ref",
    sourceType: "system",
    status: "verified",
    text: [
      `Skill reference ${metadata.id}`,
      `description=${metadata.description}`,
      `category=${metadata.category}`,
      `tags=${metadata.tags.join(",") || "-"}`
    ].join("\n"),
    title: `Skill ${metadata.id}`
  } satisfies ContextFragment;

  return {
    fragment,
    id: metadata.id,
    reason: `skill_score=${score.toFixed(4)}`,
    score,
    scope: "skill_ref",
    tokenEstimate: estimateTokens(fragment.text)
  };
}

function toSessionCandidate(
  fragment: ContextFragment,
  options: {
    scoreBoost?: number;
    source?: "thread_local" | "global";
  } = {}
): ScoredRecallCandidate {
  const source = options.source ?? "thread_local";
  const scoreBoost = options.scoreBoost ?? 0;
  const score = Number((fragment.confidence + scoreBoost).toFixed(4));
  return {
    fragment,
    id: fragment.memoryId,
    reason: `${fragment.explanation}; session_source=${source}; score_boost=${scoreBoost.toFixed(2)}`,
    score,
    scope: fragment.scope,
    tokenEstimate: estimateTokens(fragment.text)
  };
}

function reserveThreadLocalCandidates(
  candidates: ScoredRecallCandidate[],
  tokenBudget: number,
  minSlots: number
): {
  selected: Array<{
    id: string;
    reason: string;
    scope: ScoredRecallCandidate["scope"];
    score: number;
    selected: true;
    tokenEstimate: number;
  }>;
  selectedFragments: ContextFragment[];
  skipped: Array<{
    id: string;
    reason: string;
    scope: ScoredRecallCandidate["scope"];
    score: number;
    selected: false;
    tokenEstimate: number;
  }>;
  tokenUsed: number;
} {
  if (candidates.length === 0 || tokenBudget <= 0 || minSlots <= 0) {
    return { selected: [], selectedFragments: [], skipped: [], tokenUsed: 0 };
  }
  const sorted = [...candidates].sort((left, right) => right.score - left.score);
  const selected: Array<{
    id: string;
    reason: string;
    scope: ScoredRecallCandidate["scope"];
    score: number;
    selected: true;
    tokenEstimate: number;
  }> = [];
  const selectedFragments: ContextFragment[] = [];
  const skipped: Array<{
    id: string;
    reason: string;
    scope: ScoredRecallCandidate["scope"];
    score: number;
    selected: false;
    tokenEstimate: number;
  }> = [];
  let tokenUsed = 0;
  for (const candidate of sorted) {
    if (selected.length >= minSlots) {
      break;
    }
    const cost = Math.max(1, candidate.tokenEstimate);
    if (tokenUsed + cost > tokenBudget) {
      skipped.push({
        id: candidate.id,
        reason: `${candidate.reason}; skipped_by_budget`,
        scope: candidate.scope,
        score: candidate.score,
        selected: false,
        tokenEstimate: candidate.tokenEstimate
      });
      continue;
    }
    tokenUsed += cost;
    selected.push({
      id: candidate.id,
      reason: `${candidate.reason}; reserved_thread_local`,
      scope: candidate.scope,
      score: candidate.score,
      selected: true,
      tokenEstimate: candidate.tokenEstimate
    });
    selectedFragments.push(candidate.fragment);
  }
  return { selected, selectedFragments, skipped, tokenUsed };
}

function buildEnrichedQuery(
  task: TaskRecord,
  threadCommitmentState: ThreadCommitmentState | null | undefined,
  toolPlan: string[] | undefined
): string {
  const sessionMemory = readThreadSessionMemory(task.metadata);
  const sessionGoal = sessionMemory?.goal ?? readLegacyThreadResumeGoal(task.metadata);
  const sessionDecisions = sessionMemory?.decisions.join(" ") ?? "";
  const sessionNextActions = sessionMemory?.nextActions.join(" ") ?? "";
  const currentObjective = threadCommitmentState?.currentObjective?.title ?? "";
  const nextAction = threadCommitmentState?.nextAction?.title ?? "";
  const activeActions = (threadCommitmentState?.activeNextActions ?? []).map((action) => action.title).join(" ");
  return [
    task.input,
    sessionGoal,
    sessionDecisions,
    sessionNextActions,
    currentObjective,
    nextAction,
    activeActions,
    (toolPlan ?? []).join(" ")
  ]
    .filter(Boolean)
    .join(" ");
}

function readThreadSessionMemory(metadata: TaskRecord["metadata"]): ThreadSessionMemoryRecord | null {
  const threadResume = metadata.threadResume;
  if (typeof threadResume !== "object" || threadResume === null) {
    return null;
  }
  const sessionMemory = (threadResume as Record<string, unknown>).sessionMemory;
  if (typeof sessionMemory !== "object" || sessionMemory === null) {
    return null;
  }
  const candidate = sessionMemory as Partial<ThreadSessionMemoryRecord>;
  return typeof candidate.goal === "string" &&
    typeof candidate.summary === "string" &&
    Array.isArray(candidate.decisions) &&
    Array.isArray(candidate.openLoops) &&
    Array.isArray(candidate.nextActions)
    ? (candidate as ThreadSessionMemoryRecord)
    : null;
}

function readLegacyThreadResumeGoal(metadata: TaskRecord["metadata"]): string {
  const threadResume = metadata.threadResume;
  if (typeof threadResume !== "object" || threadResume === null) {
    return "";
  }
  const goal = (threadResume as Record<string, unknown>).goal;
  return typeof goal === "string" ? goal : "";
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

const HISTORICAL_RECALL_SIGNAL_PATTERN =
  /\b(previous|last\s*time|remember|earlier|before)\b|上次|之前|先前|记得|还记得/u;

function hasHistoricalRecallSignal(query: string): boolean {
  return HISTORICAL_RECALL_SIGNAL_PATTERN.test(query.toLowerCase());
}
