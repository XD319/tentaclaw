import type { JsonObject } from "./common.js";
import type { PrivacyLevel } from "./governance.js";
import type {
  ContextFilterDecision,
  ContextFragment,
  MemoryRecallResult,
  MemoryRecord,
  MemoryScope,
  MemorySourceType,
  RetentionPolicy
} from "./memory.js";

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
  scope: Exclude<MemoryScope, "working">;
  privacyLevel: PrivacyLevel;
  sourceLabel: string;
}

export interface LongTermMemoryWriteDecision {
  allowed: boolean;
  reason: string;
  targetScope: Exclude<MemoryScope, "working">;
}

export interface MemoryDebugView {
  recalled: MemoryRecallResult | null;
  sessionMemories: MemoryRecord[];
}

export const CONTEXT_DEBUG_SOURCE_TYPES = [
  "user_input",
  "system_prompt",
  "memory_recall",
  "tool_result",
  "filtered_out"
] as const;

export type ContextDebugSourceType = (typeof CONTEXT_DEBUG_SOURCE_TYPES)[number];

export interface ContextDebugFragment extends JsonObject {
  label: string;
  preview: string;
  sourceType: ContextDebugSourceType;
  privacyLevel: PrivacyLevel;
  retentionPolicy: RetentionPolicy;
  metadata: JsonObject;
}

export interface ContextAssemblyDebugView extends JsonObject {
  taskId: string;
  iteration: number;
  tokenBudget: {
    estimatedInputTokens: number;
    inputLimit: number;
    outputLimit: number;
    reservedOutput: number;
    usedInput: number;
    usedOutput: number;
  };
  originalTaskInput: ContextDebugFragment;
  activeContextFragments: ContextDebugFragment[];
  systemPromptFragments: ContextDebugFragment[];
  memoryRecallFragments: ContextDebugFragment[];
  toolResultFragments: ContextDebugFragment[];
  filteredOutFragments: Array<
    ContextDebugFragment & {
      filterReasonCode: ContextFilterDecision["reasonCode"];
      filterReason: string;
    }
  >;
}
