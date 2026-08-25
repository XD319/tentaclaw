import type { ConversationMessage } from "../types/index.js";

export const MEMORY_CONTEXT_SOURCE_TYPE = "memory_context_recall";

export function readMessageSourceType(message: ConversationMessage): string | undefined {
  const value = message.metadata?.sourceType;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function isStableMemoryPrefixMessage(message: ConversationMessage): boolean {
  return message.role === "system" && readMessageSourceType(message) === MEMORY_CONTEXT_SOURCE_TYPE;
}

export function isStableSystemPromptMessage(message: ConversationMessage): boolean {
  if (message.role !== "system" || isStableMemoryPrefixMessage(message)) {
    return false;
  }

  const sourceType = readMessageSourceType(message);
  if (sourceType !== undefined && sourceType !== "system_prompt") {
    return false;
  }

  const retentionKind = message.metadata?.retentionKind;
  return retentionKind === undefined || retentionKind === "working" || retentionKind === "profile";
}

export function isStablePromptPrefixMessage(message: ConversationMessage): boolean {
  return isStableSystemPromptMessage(message) || isStableMemoryPrefixMessage(message);
}

/**
 * Reorder only the leading run of system messages (before the first non-system
 * turn) as stable → variable. Later system nudges stay in place so compaction
 * and tail protection keep their existing behavior.
 */
export function stabilizeLeadingSystemPrefix(messages: ConversationMessage[]): ConversationMessage[] {
  let leadingCount = 0;
  while (leadingCount < messages.length && messages[leadingCount]?.role === "system") {
    leadingCount += 1;
  }

  const leading = messages.slice(0, leadingCount);
  if (leading.length <= 1) {
    return messages;
  }

  const stableSystem = leading.filter(isStableSystemPromptMessage);
  const stableMemory = leading.filter(isStableMemoryPrefixMessage);
  const variable = leading.filter((message) => !isStablePromptPrefixMessage(message));
  return [...stableSystem, ...stableMemory, ...variable, ...messages.slice(leadingCount)];
}
