export const SLASH_COMMANDS: Array<{ insert: string; label: string }> = [
  { insert: "/new", label: "Start a new session" },
  { insert: "/clear", label: "Save and start a new session" },
  { insert: "/sessions", label: "Focus session list" },
  { insert: "/mode plan", label: "Read-only plan mode" },
  { insert: "/mode agent", label: "Agent mode" },
  { insert: "/mode acceptEdits", label: "Accept edits mode" },
  { insert: "/model", label: "Show models" },
  { insert: "/stop", label: "Stop current task" },
  { insert: "/compact", label: "Request compaction" },
  { insert: "/diff", label: "Show file changes" },
  { insert: "/inbox", label: "Open inbox" },
  { insert: "/memory", label: "Open memory" },
  { insert: "/schedule", label: "Open schedules" },
  { insert: "/today", label: "Today summary" },
  { insert: "/sandbox", label: "Show workspace" },
  { insert: "/help", label: "Command help" }
];
