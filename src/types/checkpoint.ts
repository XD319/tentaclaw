import type { ConversationMessage, ProviderToolCall } from "./runtime.js";
import type { ContextFragment } from "./memory.js";

export interface ExecutionCheckpointRecord {
  taskId: string;
  iteration: number;
  memoryContext: ContextFragment[];
  messages: ConversationMessage[];
  pendingToolCalls: ProviderToolCall[];
  updatedAt: string;
}
