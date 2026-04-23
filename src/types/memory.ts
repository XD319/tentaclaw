import { z } from "zod";

import type { JsonObject } from "./common.js";
import type { PrivacyLevel } from "./governance.js";

export const MEMORY_SCOPES = ["session", "project", "agent"] as const;

export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_STATUSES = ["candidate", "verified", "stale", "rejected"] as const;

export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_SOURCE_TYPES = [
  "user_input",
  "tool_output",
  "session_compact",
  "final_output",
  "manual_review",
  "system"
] as const;

export type MemorySourceType = (typeof MEMORY_SOURCE_TYPES)[number];

export const RETENTION_POLICY_KINDS = ["ephemeral", "session", "project", "agent"] as const;

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
  includeExpired?: boolean;
  limit?: number;
}

export interface MemoryRecallRequest {
  taskId: string;
  query: string;
  sessionScopeKey: string;
  projectScopeKey: string;
  agentScopeKey: string;
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
  "tool_call_count"
] as const;

export type SessionCompactTriggerReason = (typeof SESSION_COMPACT_TRIGGER_REASONS)[number];

export interface SessionCompactInput {
  taskId: string;
  sessionScopeKey: string;
  messages: Array<{
    role: string;
    content: string;
    toolCallId?: string;
    toolName?: string;
    toolCalls?: Array<{
      toolCallId: string;
      toolName: string;
    }>;
  }>;
  maxMessagesBeforeCompact: number;
  tokenEstimate?: number;
  tokenThreshold?: number;
  toolCallCount?: number;
  toolCallThreshold?: number;
  pendingToolCalls?: Array<{
    toolCallId: string;
    toolName: string;
  }>;
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
  status: Extract<MemoryStatus, "verified" | "rejected" | "stale">;
  note: string;
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
  summary: z.string().min(1),
  supersedes: z.string().nullable().optional(),
  title: z.string().min(1)
});
