import { z } from "zod";

import type { JsonObject } from "./common.js";
import type { PrivacyLevel } from "./governance.js";

export const MEMORY_SCOPES = ["profile", "project", "working", "experience_ref", "skill_ref", "session_ref"] as const;

export const PERSISTED_MEMORY_SCOPES = ["profile", "project"] as const;

export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_STATUSES = ["candidate", "verified", "stale", "rejected", "archived"] as const;

export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_TIERS = ["core", "retrieval"] as const;

export type MemoryTier = (typeof MEMORY_TIERS)[number];

export const MEMORY_SOURCE_TYPES = [
  "user_input",
  "tool_output",
  "session_compact",
  "final_output",
  "manual_review",
  "system"
] as const;

export type MemorySourceType = (typeof MEMORY_SOURCE_TYPES)[number];

export const RETENTION_POLICY_KINDS = ["ephemeral", "working", "project", "profile"] as const;

export type RetentionPolicyKind = (typeof RETENTION_POLICY_KINDS)[number];

export interface RetentionPolicy extends JsonObject {
  kind: RetentionPolicyKind;
  ttlDays: number | null;
  reason: string;
}

export interface MemorySource {
  sourceType: MemorySourceType;
  taskId: string | null;
  toolCallId: string | null;
  traceEventId: string | null;
  label: string;
}

export interface MemoryRecord {
  memoryId: string;
  scope: MemoryScope;
  scopeKey: string;
  title: string;
  content: string;
  summary: string;
  source: MemorySource;
  sourceType: MemorySourceType;
  privacyLevel: PrivacyLevel;
  retentionPolicy: RetentionPolicy;
  confidence: number;
  status: MemoryStatus;
  tier: MemoryTier;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt: string | null;
  expiresAt: string | null;
  supersedes: string | null;
  conflictsWith: string[];
  keywords: string[];
  metadata: JsonObject;
}

export interface MemoryDraft {
  scope: MemoryScope;
  scopeKey: string;
  title: string;
  content: string;
  summary: string;
  source: MemorySource;
  privacyLevel: PrivacyLevel;
  retentionPolicy: RetentionPolicy;
  confidence: number;
  status: MemoryStatus;
  tier?: MemoryTier;
  expiresAt: string | null;
  supersedes?: string | null;
  conflictsWith?: string[];
  keywords: string[];
  metadata?: JsonObject;
}

export interface MemoryUpdatePatch {
  title?: string;
  content?: string;
  summary?: string;
  confidence?: number;
  status?: MemoryStatus;
  tier?: MemoryTier;
  lastVerifiedAt?: string | null;
  expiresAt?: string | null;
  supersedes?: string | null;
  conflictsWith?: string[];
  keywords?: string[];
  metadata?: JsonObject;
}

export interface MemoryQuery {
  scope?: MemoryScope;
  scopeKey?: string;
  includeRejected?: boolean;
  includeArchived?: boolean;
  includeStale?: boolean;
  includeExpired?: boolean;
  tier?: MemoryTier;
  limit?: number;
}

export interface MemoryRecallRequest {
  taskId: string;
  query: string;
  projectScopeKey: string;
  profileScopeKey: string;
  limit: number;
}

export interface MemoryRecallCandidate {
  memory: MemoryRecord;
  keywordScore: number;
  freshnessScore: number;
  confidenceScore: number;
  finalScore: number;
  explanation: string;
  downrankReasons: string[];
}

export interface ContextFragment {
  fragmentId: string;
  memoryId: string;
  scope: MemoryScope;
  title: string;
  text: string;
  sourceType: MemorySourceType;
  privacyLevel: PrivacyLevel;
  retentionPolicy: RetentionPolicy;
  status: MemoryStatus;
  confidence: number;
  explanation: string;
}

export interface ContextFilterDecision {
  fragment: ContextFragment;
  allowed: boolean;
  reasonCode:
    | "allowed"
    | "filtered_by_privacy"
    | "filtered_by_retention"
    | "filtered_by_scope"
    | "filtered_by_policy";
  reason: string;
}

export interface MemoryRecallResult {
  query: string;
  candidates: MemoryRecallCandidate[];
  decisions: ContextFilterDecision[];
  selectedFragments: ContextFragment[];
}

export const SESSION_COMPACT_TRIGGER_REASONS = [
  "message_count",
  "context_budget",
  "token_budget",
  "tool_call_count",
  "iteration_count"
] as const;

export type SessionCompactTriggerReason = (typeof SESSION_COMPACT_TRIGGER_REASONS)[number];

export interface SessionCompactInput {
  taskId: string;
  sessionScopeKey: string;
  messages: Array<{
    role: string;
    content: string;
    reasoningContent?: string;
    toolCallId?: string;
    toolName?: string;
    toolCalls?: Array<{
      toolCallId: string;
      toolName: string;
    }>;
  }>;
  maxMessagesBeforeCompact: number;
  contextWindowTokens?: number;
  protectFirstN?: number;
  protectLastN?: number;
  targetTokenBudget?: number;
  tokenEstimate?: number;
  tokenThreshold?: number;
  toolCallCount?: number;
  toolCallThreshold?: number;
  iteration?: number;
  iterationThreshold?: number;
  /** Count-based triggers fire only when tokenEstimate >= ratio * tokenThreshold. */
  minTokenPressureRatio?: number;
  /** Skip proactive compaction while this is > 0 (set after an ineffective compact). */
  compactCooldownRemaining?: number;
  pendingToolCalls?: Array<{
    toolCallId: string;
    toolName: string;
  }>;
  /**
   * Original user goal (typically `TaskRecord.input`). Used as a fallback when the
   * compacted message window no longer contains any user-role messages, so the
   * structured session summary never degrades to `goal=[n/a]`.
   */
  originalGoal?: string;
  /** Human-readable list of paths still pinned in context after compaction. */
  recentlyReadFilesSummary?: string;
  /** Prior session handoff summary for iterative compaction updates. */
  previousSummary?: string;
  /** Optional user focus instructions for manual compaction. */
  focusTopic?: string;
}

export interface SessionCompactResult {
  triggered: boolean;
  reason: SessionCompactTriggerReason | null;
  summaryMemory: MemoryRecord | null;
  replacementMessages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    toolCallId?: string;
    toolName?: string;
  }>;
}

export interface MemorySnapshotRecord {
  snapshotId: string;
  scope: MemoryScope;
  scopeKey: string;
  label: string;
  createdAt: string;
  createdBy: string;
  memoryIds: string[];
  summary: string;
  metadata: JsonObject;
}

export interface MemorySnapshotDraft {
  scope: MemoryScope;
  scopeKey: string;
  label: string;
  createdBy: string;
  memoryIds: string[];
  summary: string;
  metadata?: JsonObject;
}

export interface MemorySnapshotDiff {
  snapshotId: string;
  addedMemoryIds: string[];
  removedMemoryIds: string[];
}

export interface MemoryReviewRequest {
  memoryId: string;
  reviewerId: string;
  status: Extract<MemoryStatus, "verified" | "rejected" | "stale" | "archived">;
  note: string;
}

export interface MemoryEmbeddingRecord {
  memoryId: string;
  contentHash: string;
  model: string;
  dimensions: number;
  embedding: Float32Array;
  updatedAt: string;
}
export interface SessionCoreSnapshotRecord {
  snapshotId: string;
  sessionId: string;
  profileScopeKey: string;
  projectScopeKey: string;
  profileMemoryIds: string[];
  projectMemoryIds: string[];
  profileText: string;
  projectText: string;
  createdAt: string;
}

export interface SessionCoreSnapshotDraft {
  sessionId: string;
  profileScopeKey: string;
  projectScopeKey: string;
  profileMemoryIds: string[];
  projectMemoryIds: string[];
  profileText: string;
  projectText: string;
}

export const memoryDraftSchema = z.object({
  confidence: z.number().min(0).max(1),
  content: z.string().min(1),
  conflictsWith: z.array(z.string().min(1)).default([]),
  expiresAt: z.string().datetime().nullable(),
  keywords: z.array(z.string().min(1)).min(1),
  metadata: z.record(z.string(), z.json()).default({}),
  privacyLevel: z.enum(["public", "internal", "restricted"]),
  retentionPolicy: z.object({
    kind: z.enum(RETENTION_POLICY_KINDS),
    reason: z.string().min(1),
    ttlDays: z.number().int().positive().nullable()
  }),
  scope: z.enum(MEMORY_SCOPES),
  scopeKey: z.string().min(1),
  source: z.object({
    label: z.string().min(1),
    sourceType: z.enum(MEMORY_SOURCE_TYPES),
    taskId: z.string().nullable(),
    toolCallId: z.string().nullable(),
    traceEventId: z.string().nullable()
  }),
  status: z.enum(MEMORY_STATUSES),
  tier: z.enum(MEMORY_TIERS).default("retrieval"),
  summary: z.string().min(1),
  supersedes: z.string().nullable().optional(),
  title: z.string().min(1)
});
