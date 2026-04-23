import { z } from "zod";

import type { JsonObject } from "./common.js";
import type { MemoryScope } from "./memory.js";

export const EXPERIENCE_TYPES = [
  "decision",
  "pattern",
  "convention",
  "gotcha",
  "task_outcome",
  "review_feedback",
  "failure_lesson",
  "preference_signal"
] as const;

export type ExperienceType = (typeof EXPERIENCE_TYPES)[number];

export const EXPERIENCE_SOURCE_TYPES = [
  "task",
  "tool_result",
  "reviewer",
  "delegation",
  "session_end",
  "manual_import"
] as const;

export type ExperienceSourceType = (typeof EXPERIENCE_SOURCE_TYPES)[number];

export const EXPERIENCE_STATUSES = [
  "candidate",
  "accepted",
  "promoted",
  "rejected",
  "stale"
] as const;

export type ExperienceStatus = (typeof EXPERIENCE_STATUSES)[number];

export const EXPERIENCE_PROMOTION_TARGETS = [
  "project_memory",
  "profile_memory",
  "agent_memory",
  "skill_candidate"
] as const;

export type ExperiencePromotionTarget = (typeof EXPERIENCE_PROMOTION_TARGETS)[number];

export interface ExperienceScope extends JsonObject {
  scope: MemoryScope | "workspace" | "global";
  scopeKey: string;
  paths: string[];
}

export interface ExperienceProvenance extends JsonObject {
  taskId: string | null;
  toolCallId: string | null;
  traceEventId: string | null;
  reviewerId: string | null;
  sourceLabel: string;
}

export interface ExperienceIndexSignals extends JsonObject {
  tokens: string[];
  phrases: string[];
  types: ExperienceType[];
  sourceTypes: ExperienceSourceType[];
  statuses: ExperienceStatus[];
  scopes: string[];
  paths: string[];
  errorCodes: string[];
  reviewers: string[];
  taskStatuses: string[];
  valueScore: number;
}

export interface ExperienceRecord {
  experienceId: string;
  type: ExperienceType;
  sourceType: ExperienceSourceType;
  status: ExperienceStatus;
  title: string;
  summary: string;
  content: string;
  scope: ExperienceScope;
  confidence: number;
  valueScore: number;
  promotionTarget: ExperiencePromotionTarget | null;
  promotedMemoryId: string | null;
  provenance: ExperienceProvenance;
  keywords: string[];
  keywordPhrases: string[];
  indexSignals: ExperienceIndexSignals;
  metadata: JsonObject;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
  promotedAt: string | null;
}

export interface ExperienceDraft {
  type: ExperienceType;
  sourceType: ExperienceSourceType;
  status: ExperienceStatus;
  title: string;
  summary: string;
  content: string;
  scope: ExperienceScope;
  confidence: number;
  valueScore: number;
  promotionTarget?: ExperiencePromotionTarget | null;
  provenance: ExperienceProvenance;
  keywords: string[];
  keywordPhrases?: string[];
  indexSignals: ExperienceIndexSignals;
  metadata?: JsonObject;
}

export interface ExperienceUpdatePatch {
  status?: ExperienceStatus;
  title?: string;
  summary?: string;
  content?: string;
  confidence?: number;
  valueScore?: number;
  promotionTarget?: ExperiencePromotionTarget | null;
  promotedMemoryId?: string | null;
  keywords?: string[];
  keywordPhrases?: string[];
  indexSignals?: ExperienceIndexSignals;
  metadata?: JsonObject;
  reviewedAt?: string | null;
  promotedAt?: string | null;
}

export interface ExperienceQuery {
  type?: ExperienceType;
  sourceType?: ExperienceSourceType;
  status?: ExperienceStatus;
  statuses?: ExperienceStatus[];
  minValueScore?: number;
  taskId?: string;
  reviewerId?: string;
  scope?: string;
  scopeKey?: string;
  limit?: number;
}

const experienceScopeSchema = z.object({
  paths: z.array(z.string()).default([]),
  scope: z.union([z.enum(["workspace", "global"]), z.enum(["working", "project", "profile"])]),
  scopeKey: z.string().min(1)
});

const experienceProvenanceSchema = z.object({
  reviewerId: z.string().nullable(),
  sourceLabel: z.string().min(1),
  taskId: z.string().nullable(),
  toolCallId: z.string().nullable(),
  traceEventId: z.string().nullable()
});

const experienceIndexSignalsSchema = z.object({
  errorCodes: z.array(z.string()).default([]),
  paths: z.array(z.string()).default([]),
  phrases: z.array(z.string()).default([]),
  reviewers: z.array(z.string()).default([]),
  scopes: z.array(z.string()).default([]),
  sourceTypes: z.array(z.enum(EXPERIENCE_SOURCE_TYPES)).default([]),
  statuses: z.array(z.enum(EXPERIENCE_STATUSES)).default([]),
  taskStatuses: z.array(z.string()).default([]),
  tokens: z.array(z.string()).default([]),
  types: z.array(z.enum(EXPERIENCE_TYPES)).default([]),
  valueScore: z.number().min(0).max(1)
});

export const experienceDraftSchema = z.object({
  confidence: z.number().min(0).max(1),
  content: z.string().min(1),
  indexSignals: experienceIndexSignalsSchema,
  keywordPhrases: z.array(z.string().min(1)).default([]),
  keywords: z.array(z.string().min(1)).min(1),
  metadata: z.record(z.string(), z.json()).default({}),
  promotionTarget: z.enum(EXPERIENCE_PROMOTION_TARGETS).nullable().optional(),
  provenance: experienceProvenanceSchema,
  scope: experienceScopeSchema,
  sourceType: z.enum(EXPERIENCE_SOURCE_TYPES),
  status: z.enum(EXPERIENCE_STATUSES),
  summary: z.string().min(1),
  title: z.string().min(1),
  type: z.enum(EXPERIENCE_TYPES),
  valueScore: z.number().min(0).max(1)
});
