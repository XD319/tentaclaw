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
      workingScopeKey: string;
      projectScopeKey: string;
      profileScopeKey: string;
      limit: number;
    }) => MemoryRecallResult;
    recordRecall: (taskId: string, recall: MemoryRecallResult) => void;
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
      taskId: input.task.taskId,
      workingScopeKey: input.task.taskId
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

    const selection = this.selector.select(
      [...memoryCandidates, ...experienceCandidates, ...skillCandidates],
      {
        scopeWeights: budget.scopeWeights,
        tokenBudget: budget.totalTokenBudget
      }
    );

    const explain: RecallExplainPayload = {
      candidateCount: memoryCandidates.length + experienceCandidates.length + skillCandidates.length,
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
      taskId: input.task.taskId,
      workingScopeKey: input.task.taskId
    });
    this.dependencies.memoryPlane.recordRecall(input.task.taskId, memoryRecall);
    const skillFragments = this.dependencies.skillContextService.buildContext(input.task);
    const fragments = [...memoryRecall.selectedFragments, ...skillFragments];
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

function buildEnrichedQuery(
  task: TaskRecord,
  threadCommitmentState: ThreadCommitmentState | null | undefined,
  toolPlan: string[] | undefined
): string {
  const metadataThreadGoal = readThreadGoal(task.metadata);
  const currentObjective = threadCommitmentState?.currentObjective?.title ?? "";
  const nextAction = threadCommitmentState?.nextAction?.title ?? "";
  const activeActions = (threadCommitmentState?.activeNextActions ?? []).map((action) => action.title).join(" ");
  return [
    task.input,
    metadataThreadGoal,
    currentObjective,
    nextAction,
    activeActions,
    (toolPlan ?? []).join(" ")
  ]
    .filter(Boolean)
    .join(" ");
}

function readThreadGoal(metadata: TaskRecord["metadata"]): string {
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
