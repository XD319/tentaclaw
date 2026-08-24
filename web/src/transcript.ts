export interface TranscriptMessage {
  eventType?: string;
  id: string;
  kind: string;
  text: string;
  timestamp?: string;
}

const GENERIC_TITLES = new Set([
  "assistant",
  "New chat",
  "Recovered session",
  "Untitled conversation",
  "Untitled session"
]);

const DIALOG_KINDS = new Set(["agent", "approval_result", "error", "system", "user"]);

export function messageText(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return "";
  }
  const row = value as Record<string, unknown>;
  if (typeof row.text === "string" && row.text.length > 0) {
    return row.text;
  }
  if (typeof row.message === "string" && row.message.length > 0) {
    return row.message;
  }
  return "";
}

export function normalizeChatMessages(values: unknown[]): TranscriptMessage[] {
  return values.map((value, index) => {
    const row = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    const event =
      typeof row.event === "object" && row.event !== null ? (row.event as Record<string, unknown>) : null;
    const id = typeof row.id === "string" && row.id.length > 0 ? row.id : `msg:${String(index)}`;
    const kind = typeof row.kind === "string" && row.kind.length > 0 ? row.kind : "system";
    const timestamp = typeof row.timestamp === "string" ? row.timestamp : undefined;
    const eventType = typeof event?.eventType === "string" ? event.eventType : undefined;
    return {
      id,
      kind,
      text: messageText(row),
      ...(eventType !== undefined ? { eventType } : {}),
      ...(timestamp !== undefined ? { timestamp } : {})
    };
  });
}

export function dialogMessages(messages: TranscriptMessage[]): TranscriptMessage[] {
  return messages.filter((message) => DIALOG_KINDS.has(message.kind) && message.text.trim().length > 0);
}

export function mergeTranscript(
  server: TranscriptMessage[],
  current: TranscriptMessage[]
): TranscriptMessage[] {
  const serverKeys = new Set(server.map((message) => `${message.kind}:${message.text}`));
  const pending = current.filter(
    (message) => message.id.startsWith("local:") && !serverKeys.has(`${message.kind}:${message.text}`)
  );
  return pending.length === 0 ? server : [...server, ...pending];
}

export function activityTrace(
  messages: TranscriptMessage[]
): Array<{ eventType: string; summary: string }> {
  return messages
    .filter((message) => message.kind === "activity")
    .slice(-80)
    .map((message) => ({
      eventType: message.eventType ?? "activity",
      summary: message.text
    }));
}

export function sessionLabel(session: { preview?: string; sessionId: string; title?: string }): string {
  const title = session.title?.trim() ?? "";
  if (title.length > 0 && !GENERIC_TITLES.has(title)) {
    return title;
  }
  const preview = session.preview?.trim() ?? "";
  if (preview.length > 0) {
    return preview;
  }
  return title.length > 0 ? title : session.sessionId.slice(0, 8);
}

export function formatSessionTime(value?: string): string {
  if (value === undefined || value.length === 0) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}
