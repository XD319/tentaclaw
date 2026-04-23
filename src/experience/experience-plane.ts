import { z } from "zod";

import { createProfileScopeKey, type MemoryPlane } from "../memory/memory-plane.js";
import {
  RecallEngine,
  extractKeywordPhrases,
  tokenize,
  uniqueStrings,
  type ExperienceRecallCandidate
} from "../recall/recall-engine.js";
import type { TraceService } from "../tracing/trace-service.js";
import {
  EXPERIENCE_PROMOTION_TARGETS,
  experienceDraftSchema,
  type ExperienceDraft,
  type ExperiencePromotionTarget,
  type ExperienceQuery,
  type ExperienceRecord,
  type ExperienceRepository,
  type ExperienceStatus,
  type MemoryRecord,
  type TaskRecord
} from "../types/index.js";

export interface ExperiencePlaneDependencies {
  experienceRepository: ExperienceRepository;
  memoryPlane: MemoryPlane;
  traceService: TraceService;
}

export interface ExperienceReviewRequest {
  experienceId: string;
  reviewerId: string;
  status: Extract<ExperienceStatus, "accepted" | "rejected" | "stale">;
  note: string;
  valueScore?: number;
}

export interface ExperiencePromoteRequest {
  experienceId: string;
  target: ExperiencePromotionTarget;
  reviewerId: string;
  note: string;
  task?: TaskRecord;
}

export interface ExperiencePromoteResult {
  experience: ExperienceRecord;
  memory: MemoryRecord | null;
}

const experienceReviewSchema = z.object({
  experienceId: z.string().min(1),
  note: z.string().min(1),
  reviewerId: z.string().min(1),
  status: z.enum(["accepted", "rejected", "stale"]),
  valueScore: z.number().min(0).max(1).optional()
});

const experiencePromoteSchema = z.object({
  experienceId: z.string().min(1),
  note: z.string().min(1),
  reviewerId: z.string().min(1),
  target: z.enum(EXPERIENCE_PROMOTION_TARGETS)
});

export class ExperiencePlane {
  private readonly recallEngine = new RecallEngine();

  public constructor(private readonly dependencies: ExperiencePlaneDependencies) {}

  public capture(draft: ExperienceDraft): ExperienceRecord {
    const parsed = experienceDraftSchema.parse({
      ...draft,
      indexSignals: normalizeIndexSignals(draft),
      keywordPhrases: uniqueStrings([
        ...(draft.keywordPhrases ?? []),
        ...extractKeywordPhrases(`${draft.title} ${draft.summary} ${draft.content}`)
      ]),
      keywords: uniqueStrings([
        ...draft.keywords,
        ...tokenize(`${draft.title} ${draft.summary} ${draft.content}`)
      ])
    });
    const experience = this.dependencies.experienceRepository.create({
      ...parsed,
      promotionTarget: parsed.promotionTarget ?? null
    });

    this.dependencies.traceService.record({
      actor: "experience.plane",
      eventType: "experience_captured",
      payload: {
        experienceId: experience.experienceId,
        sourceType: experience.sourceType,
        status: experience.status,
        type: experience.type,
        valueScore: experience.valueScore
      },
      stage: "memory",
      summary: `Experience ${experience.experienceId} captured`,
      taskId: experience.provenance.taskId ?? "experience-admin"
    });

    return experience;
  }

  public list(query?: ExperienceQuery): ExperienceRecord[] {
    return this.dependencies.experienceRepository.list(query);
  }

  public show(experienceId: string): ExperienceRecord | null {
    return this.dependencies.experienceRepository.findById(experienceId);
  }

  public review(request: ExperienceReviewRequest): ExperienceRecord {
    const parsed = experienceReviewSchema.parse(request);
    const current = this.requireExperience(parsed.experienceId);
    const now = new Date().toISOString();
    const nextValueScore =
      parsed.valueScore ??
      (parsed.status === "accepted"
        ? Math.max(current.valueScore, 0.75)
        : parsed.status === "rejected"
          ? Math.min(current.valueScore, 0.2)
          : Math.min(current.valueScore, 0.35));
    const reviewed = this.dependencies.experienceRepository.update(current.experienceId, {
      confidence:
        parsed.status === "accepted"
          ? Math.max(current.confidence, 0.85)
          : parsed.status === "rejected"
            ? Math.min(current.confidence, 0.2)
            : Math.min(current.confidence, 0.45),
      metadata: {
        ...current.metadata,
        reviewNote: parsed.note,
        reviewedBy: parsed.reviewerId
      },
      reviewedAt: now,
      status: parsed.status,
      valueScore: nextValueScore
    });

    this.dependencies.traceService.record({
      actor: `reviewer.${parsed.reviewerId}`,
      eventType: "experience_reviewed",
      payload: {
        experienceId: reviewed.experienceId,
        reviewerId: parsed.reviewerId,
        status: reviewed.status,
        valueScore: reviewed.valueScore
      },
      stage: "memory",
      summary: `Experience ${reviewed.experienceId} reviewed as ${reviewed.status}`,
      taskId: reviewed.provenance.taskId ?? "experience-admin"
    });

    return reviewed;
  }

  public promote(request: ExperiencePromoteRequest): ExperiencePromoteResult {
    const parsed = experiencePromoteSchema.parse(request);
    const current = this.requireExperience(parsed.experienceId);
    if (current.status !== "accepted") {
      throw new Error(`Experience ${current.experienceId} must be accepted before promotion.`);
    }

    const now = new Date().toISOString();
    const memory =
      parsed.target === "skill_candidate"
        ? null
        : this.dependencies.memoryPlane.writeMemory({
            confidence: Math.max(current.confidence, 0.85),
            content: current.content,
            expiresAt: null,
            keywords: current.keywords,
            privacyLevel: "internal",
            retentionPolicy: {
              kind: parsed.target === "project_memory" ? "project" : "profile",
              reason: `Promoted from accepted experience ${current.experienceId}.`,
              ttlDays: 90
            },
            scope: parsed.target === "project_memory" ? "project" : "profile",
            scopeKey:
              parsed.target === "project_memory"
                ? current.scope.scopeKey
                : request.task === undefined
                  ? current.scope.scopeKey
                  : createProfileScopeKey(request.task),
            source: {
              label: `Promoted experience: ${current.title}`,
              sourceType: "manual_review",
              taskId: current.provenance.taskId,
              toolCallId: current.provenance.toolCallId,
              traceEventId: current.provenance.traceEventId
            },
            status: "verified",
            summary: current.summary,
            title: current.title
          });

    const promoted = this.dependencies.experienceRepository.update(current.experienceId, {
      metadata: {
        ...current.metadata,
        promotionNote: parsed.note,
        promotedBy: parsed.reviewerId,
        skillCandidate:
          parsed.target === "skill_candidate"
            ? {
                content: current.content,
                sourceExperienceId: current.experienceId,
                title: current.title
              }
            : null
      },
      promotedAt: now,
      promotedMemoryId: memory?.memoryId ?? null,
      promotionTarget: parsed.target,
      status: "promoted"
    });

    this.dependencies.traceService.record({
      actor: `reviewer.${parsed.reviewerId}`,
      eventType: "experience_promoted",
      payload: {
        experienceId: promoted.experienceId,
        promotedMemoryId: promoted.promotedMemoryId,
        target: parsed.target
      },
      stage: "memory",
      summary: `Experience ${promoted.experienceId} promoted to ${parsed.target}`,
      taskId: promoted.provenance.taskId ?? "experience-admin"
    });

    return {
      experience: promoted,
      memory
    };
  }

  public search(query: string, filters: ExperienceQuery = {}): ExperienceRecallCandidate[] {
    const candidates = this.recallEngine.rankExperiences(
      this.dependencies.experienceRepository.list(filters),
      {
        filters,
        limit: filters.limit ?? 10,
        query
      }
    );

    this.dependencies.traceService.record({
      actor: "experience.plane",
      eventType: "experience_recall_ranked",
      payload: {
        entries: candidates.map((candidate) => ({
          downrankReasons: candidate.downrankReasons,
          experienceId: candidate.experience.experienceId,
          explanation: candidate.explanation,
          finalScore: candidate.finalScore,
          status: candidate.experience.status,
          title: candidate.experience.title,
          type: candidate.experience.type,
          valueScore: candidate.experience.valueScore
        })),
        query,
        selectedExperienceIds: candidates.map((candidate) => candidate.experience.experienceId)
      },
      stage: "memory",
      summary: `Experience recall ranked ${candidates.length} candidates`,
      taskId: "experience-search"
    });

    return candidates;
  }

  private requireExperience(experienceId: string): ExperienceRecord {
    const experience = this.dependencies.experienceRepository.findById(experienceId);
    if (experience === null) {
      throw new Error(`Experience ${experienceId} was not found.`);
    }
    return experience;
  }
}

function normalizeIndexSignals(draft: ExperienceDraft): ExperienceDraft["indexSignals"] {
  return {
    errorCodes: uniqueStrings(draft.indexSignals.errorCodes),
    paths: uniqueStrings([...draft.scope.paths, ...draft.indexSignals.paths]),
    phrases: uniqueStrings([
      ...draft.indexSignals.phrases,
      ...(draft.keywordPhrases ?? []),
      ...extractKeywordPhrases(`${draft.title} ${draft.summary}`)
    ]),
    reviewers: uniqueStrings(
      [draft.provenance.reviewerId, ...draft.indexSignals.reviewers].filter(
        (reviewer): reviewer is string => reviewer !== null
      )
    ),
    scopes: uniqueStrings([
      `${draft.scope.scope}:${draft.scope.scopeKey}`,
      ...draft.indexSignals.scopes
    ]),
    sourceTypes: uniqueTyped([draft.sourceType, ...draft.indexSignals.sourceTypes]),
    statuses: uniqueTyped([draft.status, ...draft.indexSignals.statuses]),
    taskStatuses: uniqueStrings(draft.indexSignals.taskStatuses),
    tokens: uniqueStrings([
      ...draft.indexSignals.tokens,
      ...draft.keywords,
      ...tokenize(`${draft.type} ${draft.sourceType} ${draft.status}`)
    ]),
    types: uniqueTyped([draft.type, ...draft.indexSignals.types]),
    valueScore: draft.valueScore
  };
}

function uniqueTyped<T extends string>(values: T[]): T[] {
  return [...new Set(values)];
}
