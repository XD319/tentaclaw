import { ProviderError } from "../providers/index.js";
import { MockProvider } from "../providers/mock-provider.js";
import { createApplication, createDefaultRunOptions, resolveAppConfig } from "../runtime/index.js";
import { requireProviderManifest } from "../providers/index.js";
import type {
  ApprovalRecord,
  AuditLogRecord,
  Provider,
  RunMetadataRecord,
  TaskRecord,
  TraceEvent,
  ToolCallRecord
} from "../types/index.js";

export interface ReplayOptions {
  cwd?: string;
  fromIteration?: number;
  providerMode?: "current" | "mock";
}

export interface ReplayIterationSummary {
  approvals: number;
  failureCategory: "none" | "policy_or_tool" | "provider";
  finalOutcomeStatus: "cancelled" | "failed" | "missing" | "succeeded";
  iteration: number;
  modelResponseKind: "final" | "retry" | "tool_calls" | "unknown";
  providerErrorCategory: string | null;
  toolNames: string[];
  usage: {
    cachedInputTokens: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface ReplayReference {
  approvalSummaries: string[];
  auditSummaries: string[];
  diagnosis: {
    category: "prompt_or_context" | "provider" | "tool_or_policy" | "unknown";
    rationale: string;
  };
  fromIteration: number;
  iterationSummaries: ReplayIterationSummary[];
  runMetadata: RunMetadataRecord | null;
  selectedTrace: TraceEvent[];
  task: TaskRecord;
  toolCalls: ToolCallRecord[];
  trace: TraceEvent[];
}

export interface ReplayRunResult {
  providerMode: "current" | "mock";
  reference: ReplayReference;
  replayTask: TaskRecord;
  trace: TraceEvent[];
}

export function buildReplayReference(input: {
  approvals: ApprovalRecord[];
  auditLogs: AuditLogRecord[];
  fromIteration?: number;
  runMetadata: RunMetadataRecord | null;
  task: TaskRecord;
  trace: TraceEvent[];
  toolCalls: ToolCallRecord[];
}): ReplayReference {
  const fromIteration = Math.max(1, input.fromIteration ?? 1);
  const filteredTrace = filterTraceFromIteration(input.trace, fromIteration);
  const filteredToolCalls = input.toolCalls.filter((toolCall) => toolCall.iteration >= fromIteration);
  const iterationSummaries = summarizeIterations(filteredTrace);

  return {
    approvalSummaries: input.approvals.map(
      (approval) =>
        `${approval.toolName}:${approval.status}:reviewer=${approval.reviewerId ?? "-"}`
    ),
    auditSummaries: input.auditLogs.map(
      (entry) => `${entry.action}:${entry.outcome}:${entry.summary}`
    ),
    diagnosis: diagnoseReplay(input.task, filteredTrace, filteredToolCalls),
    fromIteration,
    iterationSummaries,
    runMetadata: input.runMetadata,
    selectedTrace: filteredTrace,
    task: input.task,
    toolCalls: filteredToolCalls,
    trace: input.trace
  };
}

export async function replayTaskById(
  taskId: string,
  options: ReplayOptions = {}
): Promise<ReplayRunResult> {
  const cwd = options.cwd ?? process.cwd();
  const inspectHandle = createApplication(cwd);

  try {
    const details = inspectHandle.service.showTask(taskId);
    if (details.task === null) {
      throw new Error(`Task ${taskId} not found.`);
    }

    const runMetadata = inspectHandle.infrastructure.storage.runMetadata.findByTaskId(taskId);
    const auditLogs = inspectHandle.service.auditTask(taskId);
    const reference = buildReplayReference({
      approvals: details.approvals,
      auditLogs,
      ...(options.fromIteration !== undefined
        ? { fromIteration: options.fromIteration }
        : {}),
      runMetadata,
      task: details.task,
      trace: details.trace,
      toolCalls: details.toolCalls
    });

    const appConfig = resolveAppConfig(reference.task.cwd);
    const providerMode = options.providerMode ?? "current";
    const provider =
      providerMode === "mock"
        ? createReplayMockProvider(reference)
        : undefined;
    const mockManifest = requireProviderManifest("mock");
    const replayHandle =
      provider === undefined
        ? createApplication(reference.task.cwd)
        : createApplication(reference.task.cwd, {
            config: {
              provider: {
                ...appConfig.provider,
                displayName: mockManifest.displayName,
                family: mockManifest.family,
                model: "replay-mock",
                name: "mock",
                transport: mockManifest.transport
              }
            },
            provider
          });

    try {
      const replayPrompt = buildReplayPrompt(reference, providerMode);
      const runOptions = createDefaultRunOptions(
        replayPrompt,
        reference.task.cwd,
        replayHandle.config
      );
      runOptions.agentProfileId = reference.task.agentProfileId;
      runOptions.maxIterations = reference.task.maxIterations;
      runOptions.metadata = {
        replayFromIteration: reference.fromIteration,
        replayOfTaskId: reference.task.taskId,
        replayProviderMode: providerMode
      };

      const runResult = await replayHandle.service.runTask(runOptions);
      return {
        providerMode,
        reference,
        replayTask: runResult.task,
        trace: replayHandle.service.traceTask(runResult.task.taskId)
      };
    } finally {
      replayHandle.close();
    }
  } finally {
    inspectHandle.close();
  }
}

function buildReplayPrompt(
  reference: ReplayReference,
  providerMode: "current" | "mock"
): string {
  const iterationLines = reference.iterationSummaries.map(
    (summary) =>
      `iteration=${summary.iteration} kind=${summary.modelResponseKind} tools=${summary.toolNames.join(",") || "-"} providerError=${summary.providerErrorCategory ?? "-"} final=${summary.finalOutcomeStatus}`
  );
  const toolLines = reference.toolCalls.slice(0, 6).map(
    (toolCall) =>
      `${toolCall.iteration}:${toolCall.toolName}:${toolCall.status}:${toolCall.summary ?? toolCall.errorMessage ?? "-"}`
  );

  return [
    `Replay task ${reference.task.taskId} from original iteration ${reference.fromIteration}.`,
    `Provider mode: ${providerMode}.`,
    `Original task: ${reference.task.input}`,
    `Original provider: ${reference.task.providerName}; original model: ${readRunMetadataModel(reference.runMetadata) ?? reference.runMetadata?.providerName ?? "-"}.`,
    `Current diagnosis: ${reference.diagnosis.category} because ${reference.diagnosis.rationale}`,
    `Iteration chain: ${iterationLines.join(" | ")}`,
    `Historical tool results: ${toolLines.join(" | ") || "none"}`,
    "Use the historical trace and tool outcomes as debugging reference while replaying."
  ].join("\n");
}

function filterTraceFromIteration(trace: TraceEvent[], fromIteration: number): TraceEvent[] {
  return trace.filter((event) => {
    const iteration = extractIteration(event);
    return iteration === null || iteration >= fromIteration;
  });
}

function summarizeIterations(trace: TraceEvent[]): ReplayIterationSummary[] {
  const iterations = new Set<number>();
  for (const event of trace) {
    const iteration = extractIteration(event);
    if (iteration !== null) {
      iterations.add(iteration);
    }
  }

  return [...iterations]
    .sort((left, right) => left - right)
    .map((iteration) => summarizeIteration(trace, iteration));
}

function summarizeIteration(trace: TraceEvent[], iteration: number): ReplayIterationSummary {
  const events = trace.filter((event) => extractIteration(event) === iteration);
  const modelResponse = events.find((event) => event.eventType === "model_response");
  const providerFailure = events.find((event) => event.eventType === "provider_request_failed");
  const finalOutcome = events.find((event) => event.eventType === "final_outcome");
  const approvals = events.filter((event) => event.eventType === "approval_requested").length;
  const toolNames = events
    .filter((event): event is Extract<TraceEvent, { eventType: "tool_call_requested" }> => event.eventType === "tool_call_requested")
    .map((event) => event.payload.toolName);
  const usage = events.reduce(
    (accumulator, event) => {
      if (event.eventType !== "provider_request_succeeded") {
        return accumulator;
      }

      const usagePayload = event.payload.usage;
      const inputTokens =
        typeof usagePayload?.inputTokens === "number" ? usagePayload.inputTokens : 0;
      const outputTokens =
        typeof usagePayload?.outputTokens === "number" ? usagePayload.outputTokens : 0;
      const totalTokens =
        typeof usagePayload?.totalTokens === "number"
          ? usagePayload.totalTokens
          : inputTokens + outputTokens;
      const cachedInputTokens =
        typeof usagePayload?.cachedInputTokens === "number"
          ? usagePayload.cachedInputTokens
          : 0;

      return {
        cachedInputTokens: accumulator.cachedInputTokens + cachedInputTokens,
        inputTokens: accumulator.inputTokens + inputTokens,
        outputTokens: accumulator.outputTokens + outputTokens,
        totalTokens: accumulator.totalTokens + totalTokens
      };
    },
    {
      cachedInputTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    }
  );

  return {
    approvals,
    failureCategory:
      providerFailure !== undefined
        ? "provider"
        : events.some(
              (event) =>
                event.eventType === "tool_call_failed" || event.eventType === "policy_decision"
            )
          ? "policy_or_tool"
          : "none",
    finalOutcomeStatus:
      finalOutcome?.payload.status === undefined ? "missing" : finalOutcome.payload.status,
    iteration,
    modelResponseKind:
      modelResponse?.eventType === "model_response" ? modelResponse.payload.kind : "unknown",
    providerErrorCategory:
      providerFailure?.eventType === "provider_request_failed"
        ? providerFailure.payload.errorCategory
        : null,
    toolNames,
    usage
  };
}

function diagnoseReplay(
  task: TaskRecord,
  trace: TraceEvent[],
  toolCalls: ToolCallRecord[]
): ReplayReference["diagnosis"] {
  const providerFailure = trace.find((event) => event.eventType === "provider_request_failed");
  if (providerFailure?.eventType === "provider_request_failed") {
    return {
      category: "provider",
      rationale: `trace captured provider_request_failed with ${providerFailure.payload.errorCategory}`
    };
  }

  const toolFailure = toolCalls.find(
    (toolCall) => toolCall.status === "failed" || toolCall.status === "denied" || toolCall.status === "timed_out"
  );
  if (toolFailure !== undefined) {
    return {
      category: "tool_or_policy",
      rationale: `tool ${toolFailure.toolName} ended with ${toolFailure.status}`
    };
  }

  const finalOutcome = [...trace]
    .reverse()
    .find((event) => event.eventType === "final_outcome");
  if (task.status === "failed" || finalOutcome?.eventType === "final_outcome") {
    return {
      category: "prompt_or_context",
      rationale:
        task.errorMessage ??
        "task failed without provider/tool hard failure, so prompt or context quality is the main suspect"
    };
  }

  return {
    category: "unknown",
    rationale: "trace does not show a clear single-layer failure"
  };
}

function createReplayMockProvider(reference: ReplayReference): Provider {
  const steps = reference.iterationSummaries;
  let cursor = 0;

  return new MockProvider(
    {
      model: "replay-mock"
    },
    () => {
      const step = steps[cursor];
      cursor += 1;

      if (step === undefined) {
        return {
          kind: "final",
          message: `Replay exhausted after original iteration ${reference.fromIteration}.`,
          metadata: {
            modelName: "replay-mock",
            providerName: "mock",
            retryCount: 0
          },
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2
          }
        };
      }

      if (step.providerErrorCategory !== null) {
        throw new ProviderError({
          category: step.providerErrorCategory as ProviderError["category"],
          message: `Historical replay provider failure: ${step.providerErrorCategory}`,
          modelName: "replay-mock",
          providerName: "mock",
          retriable: false,
          summary: "Replay hit the same historical provider failure category."
        });
      }

      if (step.modelResponseKind === "retry") {
        return {
          delayMs: 0,
          kind: "retry",
          message: "Replay requested retry based on historical trace.",
          metadata: {
            modelName: "replay-mock",
            providerName: "mock",
            retryCount: 0
          },
          reason: "Historical trace requested retry.",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2
          }
        };
      }

      if (step.modelResponseKind === "tool_calls") {
        const toolCalls = reference.toolCalls
          .filter((toolCall) => toolCall.iteration === step.iteration)
          .map((toolCall) => ({
            input: toolCall.input,
            reason: toolCall.summary ?? `Historical replay for ${toolCall.toolName}`,
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName
          }));

        return {
          kind: "tool_calls",
          message: `Historical replay scheduled ${toolCalls.length} tool calls.`,
          metadata: {
            modelName: "replay-mock",
            providerName: "mock",
            retryCount: 0
          },
          toolCalls,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2
          }
        };
      }

      const originalFinal = reference.selectedTrace.find(
        (event) =>
          event.eventType === "final_outcome" && extractIteration(event) === step.iteration
      );

      return {
        kind: "final",
        message:
          originalFinal?.eventType === "final_outcome" && originalFinal.payload.output !== null
            ? originalFinal.payload.output
            : `Historical replay reached final outcome for iteration ${step.iteration}.`,
        metadata: {
          modelName: "replay-mock",
          providerName: "mock",
          retryCount: 0
        },
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2
        }
      };
    }
  );
}

function readRunMetadataModel(runMetadata: RunMetadataRecord | null): string | null {
  const modelName = runMetadata?.metadata.modelName;
  return typeof modelName === "string" ? modelName : null;
}

function extractIteration(event: TraceEvent): number | null {
  const payload = event.payload as { iteration?: unknown };
  return typeof payload.iteration === "number" ? payload.iteration : null;
}
