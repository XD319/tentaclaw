export const SLASH_COMMANDS = [
  "/clear",
  "/context",
  "/cost",
  "/diff",
  "/help",
  "/history",
  "/new",
  "/sessions",
  "/sandbox",
  "/status",
  "/stop",
  "/title "
] as const;

export function longestCommonPrefix(strings: string[]): string {
  if (strings.length === 0) {
    return "";
  }
  let prefix = strings[0] ?? "";
  for (const s of strings) {
    while (!s.startsWith(prefix) && prefix.length > 0) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}

export function completeSlashCommand(value: string): string | null {
  if (!value.startsWith("/")) {
    return null;
  }
  const hits = SLASH_COMMANDS.filter((command) => command.startsWith(value));
  if (hits.length === 0) {
    return null;
  }
  if (hits.length === 1) {
    const single = hits[0] ?? "";
    return single.endsWith(" ") ? single : `${single} `;
  }
  const common = longestCommonPrefix([...hits]);
  if (common.length > value.length) {
    return common;
  }
  const first = hits[0];
  return first !== undefined ? (first.endsWith(" ") ? first : `${first} `) : null;
}
