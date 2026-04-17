import type { ConversationMessage, ProviderToolCall } from "./runtime";
import type { ContextFragment } from "./memory";

export interface ExecutionCheckpointRecord {
  taskId: string;
  iteration: number;
  memoryContext: ContextFragment[];
  messages: ConversationMessage[];
  pendingToolCalls: ProviderToolCall[];
  updatedAt: string;
}
