import { describe, expect, it } from "vitest";

import {
  activityTrace,
  dialogMessages,
  mergeTranscript,
  messageText,
  normalizeChatMessages,
  sessionLabel
} from "../web/src/transcript";

describe("web transcript helpers", () => {
  it("keeps the conversation and hides activity logs", () => {
    const messages = normalizeChatMessages([
      { id: "u1", kind: "user", text: "介绍下这个项目" },
      { event: { eventType: "task_started" }, id: "a1", kind: "activity", text: "task_started" },
      { id: "e1", kind: "error", message: "read_file failed" },
      { id: "s1", kind: "agent", text: "AutoTalon 是一个本地 Agent 运行时。" }
    ]);
    expect(dialogMessages(messages).map((message) => message.kind)).toEqual(["user", "error", "agent"]);
    expect(dialogMessages(messages)[1]?.text).toBe("read_file failed");
    expect(activityTrace(messages)).toEqual([{ eventType: "task_started", summary: "task_started" }]);
  });

  it("keeps a locally typed user message until the server transcript catches up", () => {
    const server = normalizeChatMessages([{ id: "u1", kind: "user", text: "old" }]);
    const merged = mergeTranscript(server, [
      { id: "local:1", kind: "user", text: "new question" }
    ]);
    expect(merged.map((message) => message.text)).toEqual(["old", "new question"]);
  });

  it("uses the latest user preview when the TUI default title is assistant", () => {
    expect(
      sessionLabel({
        preview: "介绍下这个项目",
        sessionId: "abc12345-id",
        title: "assistant"
      })
    ).toBe("介绍下这个项目");
    expect(sessionLabel({ sessionId: "abc12345-id", title: "assistant" })).toBe("assistant");
    expect(messageText({ kind: "error", message: "boom" })).toBe("boom");
  });
});
