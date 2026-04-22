import type { SessionCompactInput } from "../types";

export interface CompactSummarizerResult {
  summary: string;
  summarizerId: string;
}

export interface CompactSummarizer {
  summarize(input: SessionCompactInput): Promise<CompactSummarizerResult>;
}

export class DeterministicCompactSummarizer implements CompactSummarizer {
  public summarize(input: SessionCompactInput): Promise<CompactSummarizerResult> {
    return Promise.resolve({
      summarizerId: "deterministic",
      summary: summarizeMessages(input)
    });
  }
}

export class ProviderSubagentSummarizer implements CompactSummarizer {
  public summarize(input: SessionCompactInput): Promise<CompactSummarizerResult> {
    return Promise.resolve({
      summarizerId: "provider_subagent",
      summary: summarizeMessages(input)
    });
  }
}

function summarizeMessages(messages: SessionCompactInput): string {
  const userMessages = messages.messages.filter((message) => message.role === "user");
  const assistantMessages = messages.messages.filter((message) => message.role === "assistant");
  const toolMessages = messages.messages.filter((message) => message.role === "tool");

  const objective = summarize(userMessages.at(0)?.content ?? "", 220);
  const latestRequest = summarize(userMessages.at(-1)?.content ?? "", 220);
  const completedWork = summarize(
    assistantMessages
      .slice(-3)
      .map((message) => summarize(message.content, 100))
      .join(" | "),
    260
  );
  const keyToolSignals = summarize(
    toolMessages
      .slice(-3)
      .map((message) => summarize(message.content, 100))
      .join(" | "),
    260
  );

  return [
    `goal=${objective || "[n/a]"}`,
    `latest_user_request=${latestRequest || "[n/a]"}`,
    `completed_work=${completedWork || "[n/a]"}`,
    `tool_signals=${keyToolSignals || "[n/a]"}`
  ].join("\n");
}

function summarize(value: string, maxLength = 160): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength)}...`;
}
