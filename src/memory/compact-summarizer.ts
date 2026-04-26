import type { SessionCompactInput } from "../types/index.js";
import type { Provider } from "../types/index.js";

export interface CompactSummarizerResult {
  summary: string;
  summarizerId: string;
  fallbackReason?: string;
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
  public constructor(
    private readonly helperProviderFactory?: ((context: { kind: "summarize" }) => Provider | null) | undefined
  ) {}

  public async summarize(input: SessionCompactInput): Promise<CompactSummarizerResult> {
    const fallback = new DeterministicCompactSummarizer();
    const helperProvider = this.helperProviderFactory?.({ kind: "summarize" }) ?? null;
    if (helperProvider === null) {
      const fallbackResult = await fallback.summarize(input);
      return {
        fallbackReason: "provider_unavailable",
        summarizerId: "provider_subagent:fallback_deterministic",
        summary: fallbackResult.summary
      };
    }

    try {
      const response = await helperProvider.generate({
        agentProfileId: "planner",
        availableTools: [],
        iteration: 1,
        memoryContext: [],
        messages: buildSummarizerPrompt(input),
        signal: new AbortController().signal,
        task: buildSummaryTask(input),
        tokenBudget: {
          inputLimit: 2_000,
          outputLimit: 800,
          reservedOutput: 100,
          usedInput: 0,
          usedOutput: 0
        }
      });
      if (response.kind !== "final" || response.message.trim().length === 0) {
        const fallbackResult = await fallback.summarize(input);
        return {
          fallbackReason: "invalid_provider_response",
          summarizerId: `provider_subagent:${helperProvider.name}:fallback_deterministic`,
          summary: fallbackResult.summary
        };
      }
      return {
        summarizerId: `provider_subagent:${helperProvider.name}`,
        summary: redactSensitiveSummary(response.message)
      };
    } catch {
      const fallbackResult = await fallback.summarize(input);
      return {
        fallbackReason: "provider_error",
        summarizerId: `provider_subagent:${helperProvider.name}:fallback_deterministic`,
        summary: fallbackResult.summary
      };
    }
  }
}

function summarizeMessages(messages: SessionCompactInput): string {
  const structured = collectStructuredSummaryFields(messages);
  return formatStructuredSummary(structured);
}

export interface StructuredSummaryFields {
  goal: string;
  latestUserRequest: string;
  completedWork: string;
  filesTouched: string[];
  commandsRun: string[];
  blockers: string[];
  nextActions: string[];
  toolSignals: string;
}

export function collectStructuredSummaryFields(input: SessionCompactInput): StructuredSummaryFields {
  const userMessages = input.messages.filter((message) => message.role === "user");
  const assistantMessages = input.messages.filter((message) => message.role === "assistant");
  const toolMessages = input.messages.filter((message) => message.role === "tool");

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
  const filesTouched = extractFilesTouched(toolMessages);
  const commandsRun = extractCommands(toolMessages);
  const blockers = extractBlockers(toolMessages, assistantMessages);
  const nextActions = extractNextActions(assistantMessages);
  return {
    blockers,
    commandsRun,
    completedWork: completedWork || "[n/a]",
    filesTouched,
    goal: summarize(userMessages.at(0)?.content ?? "", 220) || "[n/a]",
    latestUserRequest: summarize(userMessages.at(-1)?.content ?? "", 220) || "[n/a]",
    nextActions,
    toolSignals: keyToolSignals || "[n/a]"
  };
}

export function formatStructuredSummary(fields: StructuredSummaryFields): string {
  return redactSensitiveSummary(
    [
      `goal=${fields.goal}`,
      `latest_user_request=${fields.latestUserRequest}`,
      `completedWork=${fields.completedWork}`,
      `filesTouched=${fields.filesTouched.join("; ") || "[none]"}`,
      `commandsRun=${fields.commandsRun.join("; ") || "[none]"}`,
      `blockers=${fields.blockers.join("; ") || "[none]"}`,
      `nextActions=${fields.nextActions.join("; ") || "[none]"}`,
      `tool_signals=${fields.toolSignals}`
    ].join("\n")
  );
}

export function redactSensitiveSummary(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[REDACTED_EMAIL]")
    .replace(/\b(Bearer\s+)?[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/gu, "[REDACTED_TOKEN]")
    .replace(/\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/gu, "[REDACTED_TOKEN]")
    .replace(/\b(password|secret|token|api[_-]?key)\s*[:=]\s*['"]?[^'"\s;]+/giu, "$1=[REDACTED]");
}

function extractFilesTouched(toolMessages: SessionCompactInput["messages"]): string[] {
  const matches = toolMessages.flatMap((message) => {
    const content = message.content;
    const pathHits = content.match(/([A-Za-z]:[\\/][^\s"'`]+|(?:\.{0,2}\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)/g) ?? [];
    return pathHits.filter((item) => item.includes("/") || item.includes("\\"));
  });
  return uniqueList(matches.map((item) => summarize(item, 120))).slice(0, 8);
}

function extractCommands(toolMessages: SessionCompactInput["messages"]): string[] {
  const commandRegex = /"(?:command|cmd)"\s*:\s*"([^"]+)"/g;
  const commands: string[] = [];
  for (const message of toolMessages) {
    for (const match of message.content.matchAll(commandRegex)) {
      commands.push(summarize(match[1] ?? "", 140));
    }
  }
  return uniqueList(commands).slice(0, 8);
}

function extractBlockers(
  toolMessages: SessionCompactInput["messages"],
  assistantMessages: SessionCompactInput["messages"]
): string[] {
  const source = [...toolMessages, ...assistantMessages].map((message) => message.content).join("\n");
  const candidates = source
    .split(/\n+/u)
    .map((line) => line.trim())
    .filter((line) => /\b(error|failed|denied|blocked|timeout|exception)\b/iu.test(line))
    .map((line) => summarize(line, 160));
  return uniqueList(candidates).slice(0, 6);
}

function extractNextActions(assistantMessages: SessionCompactInput["messages"]): string[] {
  const tails = assistantMessages.slice(-4).map((message) => message.content);
  const candidates = tails
    .flatMap((text) => text.split(/[\n.;]+/u))
    .map((item) => item.trim())
    .filter((item) => /\b(next|then|will|should|need to|plan)\b/iu.test(item))
    .map((item) => summarize(item, 140));
  return uniqueList(candidates).slice(0, 8);
}

function buildSummarizerPrompt(input: SessionCompactInput): Array<{ content: string; role: "system" | "user" }> {
  const structured = collectStructuredSummaryFields(input);
  return [
    {
      content:
        "You summarize an execution session. Return plain text with exactly these keys, one per line: goal, latest_user_request, completedWork, filesTouched, commandsRun, blockers, nextActions, tool_signals. No markdown.",
      role: "system"
    },
    {
      content: formatStructuredSummary(structured),
      role: "user"
    }
  ];
}

function buildSummaryTask(input: SessionCompactInput): {
  agentProfileId: "planner";
  createdAt: string;
  currentIteration: number;
  cwd: string;
  errorCode: null;
  errorMessage: null;
  finalOutput: null;
  finishedAt: null;
  input: string;
  maxIterations: number;
  metadata: {};
  providerName: string;
  requesterUserId: string;
  startedAt: string | null;
  status: "running";
  taskId: string;
  threadId: string | null;
  tokenBudget: {
    inputLimit: number;
    outputLimit: number;
    reservedOutput: number;
    usedInput: number;
    usedOutput: number;
  };
  updatedAt: string;
} {
  return {
    agentProfileId: "planner",
    createdAt: "",
    currentIteration: 1,
    cwd: "",
    errorCode: null,
    errorMessage: null,
    finalOutput: null,
    finishedAt: null,
    input: input.messages.find((message) => message.role === "user")?.content ?? "",
    maxIterations: 1,
    metadata: {},
    providerName: "summarizer",
    requesterUserId: "system",
    startedAt: null,
    status: "running",
    taskId: input.taskId,
    threadId: null,
    tokenBudget: {
      inputLimit: 2_000,
      outputLimit: 800,
      reservedOutput: 100,
      usedInput: 0,
      usedOutput: 0
    },
    updatedAt: ""
  };
}

function summarize(value: string, maxLength = 160): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength)}...`;
}

function uniqueList(values: string[]): string[] {
  return [...new Set(values.filter((item) => item.trim().length > 0))];
}
