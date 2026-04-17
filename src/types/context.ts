import type { PrivacyLevel } from "./governance";
import type {
  ContextFilterDecision,
  ContextFragment,
  MemoryRecallResult,
  MemoryRecord,
  MemoryScope,
  MemorySourceType,
  RetentionPolicy
} from "./memory";

export interface ContextBoundaryRecord {
  fragmentId: string;
  sourceType: MemorySourceType;
  privacyLevel: PrivacyLevel;
  retentionPolicy: RetentionPolicy;
  scope: MemoryScope;
  sourceLabel: string;
}

export interface ContextPolicyFilterInput {
  fragments: ContextFragment[];
}

export interface ContextPolicyFilterResult {
  allowedFragments: ContextFragment[];
  decisions: ContextFilterDecision[];
}

export interface LongTermMemoryWriteRequest {
  content: string;
  scope: Exclude<MemoryScope, "session">;
  privacyLevel: PrivacyLevel;
  sourceLabel: string;
}

export interface LongTermMemoryWriteDecision {
  allowed: boolean;
  reason: string;
  targetScope: Exclude<MemoryScope, "session">;
}

export interface MemoryDebugView {
  recalled: MemoryRecallResult | null;
  sessionMemories: MemoryRecord[];
}
