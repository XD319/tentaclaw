import type { createManagedAbortController } from "../abort-controller.js";
import type { RecentFileReadCache } from "../context/recent-file-reads.js";
import type { HybridTokenCounterState } from "../context/token-counter.js";
import type {
  ContextAssemblyDebugView,
  ContextFragment,
  ConversationMessage,
  MemoryRecallResult,
  ProviderToolCall,
  RuntimeOutputEvent,
  RuntimeRunOptions,
  RuntimeTaskEvent,
  TaskRecord,
  TokenBudget
} from "../../types/index.js";

export interface ExecutionLoopState {
  compactedCount: number;
  compactCooldownRemaining: number;
  costWarnedToolNames: string[];
  cumulativeToolCallCount: number;
  cwd: string;
  iterationsSinceLastCompact: number;
  managedAbortController: ReturnType<typeof createManagedAbortController>;
  maxIterations: number;
  microPrunedCount: number;
  memoryContext: ContextFragment[];
  memoryRecall: MemoryRecallResult | null;
  messages: ConversationMessage[];
  /** Present only when the CLI/TUI requests streamed assistant text. */
  onAssistantTextDelta?: (delta: string) => void;
  onOutputEvent?: (event: RuntimeOutputEvent) => void;
  onTaskEvent?: (event: RuntimeTaskEvent) => void;
  pendingToolCalls: ProviderToolCall[];
  completionIntentSeenAt: number | null;
  completionVerificationGuardEmitted: boolean;
  completionVerificationSatisfied: boolean;
  completionVerificationSatisfiedEmitted: boolean;
  criticalBudgetPressureEmitted: boolean;
  interactionMode?: RuntimeRunOptions["interactionMode"];
  postCompletionVerificationReads: number;
  readOnlyTurns: number;
  selectedSkillContext: ContextFragment[];
  silentToolTurns: number;
  toolCallSignatures: Map<
    string,
    { iteration: number; toolCallId: string; cachedToolOutput?: string }
  >;
  turnFilteredFragments: ContextAssemblyDebugView["filteredOutFragments"];
  turnProviderMessages: ConversationMessage[];
  recentFileReadCache: RecentFileReadCache | null;
  repoMapSummary?: string;
  task: TaskRecord;
  taskRecoveryUsed: boolean;
  tokenBudget: TokenBudget;
  tokenCounter: HybridTokenCounterState;
  toolArtifactsRoot: string;
  warningBudgetPressureEmitted: boolean;
  writeToolSucceeded: boolean;
}
