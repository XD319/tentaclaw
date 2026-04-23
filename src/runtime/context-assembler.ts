import type {
  AgentProfile,
  ConversationMessage,
  ContextAssemblyDebugView,
  ContextDebugFragment,
  ContextFragment,
  ProviderInput,
  ProviderToolDescriptor,
  TaskRecord,
  TokenBudget
} from "../types/index.js";

export interface ContextAssemblerInput {
  availableTools: ProviderToolDescriptor[];
  iteration: number;
  memoryContext: ContextFragment[];
  messages: ConversationMessage[];
  signal: AbortSignal;
  task: TaskRecord;
  tokenBudget: TokenBudget;
}

export interface AssembledProviderContext {
  debug: ContextAssemblyDebugView;
  providerInput: ProviderInput;
}

export class ExecutionContextAssembler {
  public assemble(input: ContextAssemblerInput): AssembledProviderContext {
    const providerInput = {
      availableTools: input.availableTools,
      agentProfileId: input.task.agentProfileId,
      iteration: input.iteration,
      memoryContext: input.memoryContext,
      messages: input.messages,
      signal: input.signal,
      task: input.task,
      tokenBudget: input.tokenBudget
    };

    return {
      debug: buildContextDebugView(input),
      providerInput
    };
  }

  public buildInitialMessages(
    task: TaskRecord,
    availableTools: ProviderToolDescriptor[],
    profile: AgentProfile,
    repoMapSummary?: string
  ): ConversationMessage[] {
    const systemMessage = [
      profile.systemPrompt,
      "Use tools only when needed.",
      `Available tools: ${availableTools.map((tool) => tool.name).join(", ")}.`
    ].join(" ");

    const messages: ConversationMessage[] = [
      {
        content: systemMessage,
        metadata: {
          privacyLevel: "internal",
          retentionKind: "session",
          sourceType: "system_prompt"
        },
        role: "system"
      },
    ];
    if (repoMapSummary !== undefined) {
      messages.push({
        content: repoMapSummary,
        metadata: {
          privacyLevel: "internal",
          retentionKind: "session",
          sourceType: "system_prompt"
        },
        role: "system"
      });
    }
    messages.push(
      {
        content: task.input,
        metadata: {
          privacyLevel: "internal",
          retentionKind: "session",
          sourceType: "user_input"
        },
        role: "user"
      }
    );
    return messages;
  }
}

function buildContextDebugView(input: ContextAssemblerInput): ContextAssemblyDebugView {
  const originalTaskInput = input.messages.find((message) => message.role === "user") ?? {
    content: input.task.input,
    role: "user" as const
  };

  return {
    filteredOutFragments: [],
    iteration: input.iteration,
    memoryRecallFragments: input.memoryContext.map((fragment) =>
      toMemoryDebugFragment(fragment)
    ),
    originalTaskInput: {
      label: "User task input",
      metadata: {
        role: "user"
      },
      preview: sanitizePreview(originalTaskInput.content, "internal"),
      privacyLevel: "internal",
      retentionPolicy: {
        kind: "session",
        reason: "Task input remains part of the active session context.",
        ttlDays: null
      },
      sourceType: "user_input"
    },
    tokenBudget: {
      estimatedInputTokens: estimateInputTokens(input.messages, input.memoryContext),
      inputLimit: input.tokenBudget.inputLimit,
      outputLimit: input.tokenBudget.outputLimit,
      reservedOutput: input.tokenBudget.reservedOutput,
      usedInput: input.tokenBudget.usedInput,
      usedOutput: input.tokenBudget.usedOutput
    },
    systemPromptFragments: input.messages
      .filter((message) => message.role === "system")
      .map((message, index) =>
        toMessageDebugFragment(message, "system_prompt", `System prompt ${index + 1}`)
      ),
    taskId: input.task.taskId,
    toolResultFragments: input.messages
      .filter((message) => message.role === "tool")
      .map((message, index) =>
        toMessageDebugFragment(
          message,
          "tool_result",
          message.toolName === undefined ? `Tool result ${index + 1}` : `Tool result ${message.toolName}`
        )
      )
  };
}

function estimateInputTokens(messages: ConversationMessage[], memoryContext: ContextFragment[]): number {
  const text = [
    ...messages.map((message) => message.content),
    ...memoryContext.map((fragment) => fragment.text)
  ].join("\n");
  return Math.ceil(text.length / 4);
}

export function buildFilteredContextDebugFragments(
  decisions: Array<{
    allowed: boolean;
    fragment: ContextFragment;
    reason: string;
    reasonCode: "allowed" | "filtered_by_policy" | "filtered_by_privacy" | "filtered_by_retention" | "filtered_by_scope";
  }>
): ContextAssemblyDebugView["filteredOutFragments"] {
  return decisions
    .filter((decision) => !decision.allowed)
    .map((decision) => ({
      ...toMemoryDebugFragment(decision.fragment, "filtered_out"),
      filterReason: decision.reason,
      filterReasonCode: decision.reasonCode
    }));
}

function toMemoryDebugFragment(
  fragment: ContextFragment,
  sourceType: "memory_recall" | "filtered_out" = "memory_recall"
): ContextDebugFragment {
  return {
    label: fragment.title,
    metadata: {
      confidence: Number(fragment.confidence.toFixed(2)),
      memoryId: fragment.memoryId,
      scope: fragment.scope,
      status: fragment.status
    },
    preview: sanitizePreview(fragment.text, fragment.privacyLevel),
    privacyLevel: fragment.privacyLevel,
    retentionPolicy: fragment.retentionPolicy,
    sourceType
  };
}

function toMessageDebugFragment(
  message: ConversationMessage,
  sourceType: "system_prompt" | "tool_result",
  label: string
): ContextDebugFragment {
  const privacyLevel = readPrivacyLevel(message);
  const retentionKind = readRetentionKind(message);

  return {
    label,
    metadata: {
      role: message.role,
      toolCallId: message.toolCallId ?? null,
      toolName: message.toolName ?? null
    },
    preview: sanitizePreview(message.content, privacyLevel),
    privacyLevel,
    retentionPolicy: {
      kind: retentionKind,
      reason:
        sourceType === "system_prompt"
          ? "System prompts are retained with the active session."
          : "Tool result injections are retained with the active session.",
      ttlDays: null
    },
    sourceType
  };
}

function sanitizePreview(value: string, privacyLevel: "public" | "internal" | "restricted"): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  if (privacyLevel === "restricted") {
    return "[REDACTED: restricted content]";
  }

  const masked = compact
    .replace(/\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/giu, "[REDACTED_EMAIL]")
    .replace(/\b(?:token|secret|password|passwd|api[_-]?key)\s*[:=]\s*\S+/giu, "[REDACTED_SECRET]");

  return masked.length <= 220 ? masked : `${masked.slice(0, 220)}...`;
}

function readPrivacyLevel(message: ConversationMessage): "public" | "internal" | "restricted" {
  const value = message.metadata?.privacyLevel;
  return value === "public" || value === "restricted" ? value : "internal";
}

function readRetentionKind(
  message: ConversationMessage
): "agent" | "ephemeral" | "project" | "session" {
  const value = message.metadata?.retentionKind;
  return value === "agent" || value === "ephemeral" || value === "project" ? value : "session";
}
