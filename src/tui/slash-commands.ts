export interface SlashSuggestion {
  description: string;
  insertText: string;
  key: string;
  label: string;
  rank?: number;
}

export const STATIC_SLASH_SUGGESTIONS: SlashSuggestion[] = [
  suggestion("/today", "today", "Show today's summary"),
  suggestion("/inbox", "inbox", "List pending inbox items"),
  suggestion("/thread", "thread", "Thread commands"),
  suggestion("/thread new ", "thread-new", "Create and switch to a new thread"),
  suggestion("/thread list", "thread-list", "List active threads"),
  suggestion("/thread switch ", "thread-switch", "Switch to a thread by prefix"),
  suggestion("/thread summary ", "thread-summary", "Show thread details"),
  suggestion("/next", "next", "Next action commands"),
  suggestion("/next list", "next-list", "List next actions"),
  suggestion("/next done ", "next-done", "Mark a next action done"),
  suggestion("/next block ", "next-block", "Block a next action"),
  suggestion("/commitments", "commitments", "Commitment commands"),
  suggestion("/commitments list", "commitments-list", "List commitments"),
  suggestion("/commitments done ", "commitments-done", "Mark a commitment done"),
  suggestion("/commitments block ", "commitments-block", "Block a commitment"),
  suggestion("/schedule", "schedule", "Schedule commands"),
  suggestion("/schedule list ", "schedule-list", "List schedules"),
  suggestion("/schedule create ", "schedule-create", "Create a schedule from natural language"),
  suggestion("/schedule pause ", "schedule-pause", "Pause a schedule"),
  suggestion("/schedule resume ", "schedule-resume", "Resume a schedule"),
  suggestion("/help", "help", "Show help"),
  suggestion("/ops", "ops", "Open ops guidance"),
  suggestion("/status", "status", "Show TUI status"),
  suggestion("/clear", "clear", "Clear the visible conversation"),
  suggestion("/new", "new", "Start a fresh assistant session"),
  suggestion("/stop", "stop", "Interrupt the current task"),
  suggestion("/history", "history", "Show recent prompts"),
  suggestion("/context", "context", "Show context budget summary"),
  suggestion("/memory", "memory", "Memory commands"),
  suggestion("/memory review", "memory-review", "Review queued memory suggestions"),
  suggestion("/memory add ", "memory-add", "Add memory to profile or project scope"),
  suggestion("/memory forget ", "memory-forget", "Forget a memory by prefix"),
  suggestion("/memory why", "memory-why", "Explain recalled memories"),
  suggestion("/cost", "cost", "Show token and cost estimate"),
  suggestion("/diff", "diff", "Show file write summary"),
  suggestion("/sandbox", "sandbox", "Show sandbox config"),
  suggestion("/sessions", "sessions", "List saved sessions"),
  suggestion("/rollback ", "rollback", "Rollback a file artifact"),
  suggestion("/title ", "title", "Rename the current session"),
  suggestion("/edit", "edit", "Open the current draft in an external editor")
] as const;

export const SLASH_COMMANDS = STATIC_SLASH_SUGGESTIONS.map((item) => item.insertText);

export function completeSlashCommand(
  value: string,
  suggestions: readonly SlashSuggestion[] = STATIC_SLASH_SUGGESTIONS
): string | null {
  if (!value.startsWith("/")) {
    return null;
  }
  const hits = getMatchingSuggestions(value, suggestions).map((item) => item.insertText);
  if (hits.length === 0) {
    return null;
  }
  if (hits.length === 1) {
    return withTrailingSpace(hits[0] ?? "");
  }
  const common = longestCommonPrefix(hits);
  if (common.length > value.length) {
    return withTrailingSpaceIfExact(common, hits);
  }
  return withTrailingSpace(hits[0] ?? "");
}

export function getMatchingSuggestions(
  value: string,
  suggestions: readonly SlashSuggestion[]
): SlashSuggestion[] {
  return suggestions
    .filter((item) => item.insertText.startsWith(value))
    .sort((left, right) => (left.rank ?? 0) - (right.rank ?? 0));
}

export function longestCommonPrefix(strings: readonly string[]): string {
  if (strings.length === 0) {
    return "";
  }
  let prefix = strings[0] ?? "";
  for (const value of strings) {
    while (!value.startsWith(prefix) && prefix.length > 0) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}

function withTrailingSpace(value: string): string {
  return value.endsWith(" ") ? value : `${value} `;
}

function withTrailingSpaceIfExact(prefix: string, values: readonly string[]): string {
  return values.includes(prefix) ? withTrailingSpace(prefix) : prefix;
}

function suggestion(insertText: string, key: string, description: string, rank = 0): SlashSuggestion {
  return {
    description,
    insertText,
    key,
    label: insertText.trim(),
    rank
  };
}
