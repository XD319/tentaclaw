import type {
  JsonObject,
  ProviderResponse,
  ProviderResponseMetadata,
  ProviderToolCall
} from "../types/index.js";

import { ProviderError } from "./provider-error.js";

export function assertProviderResponse(
  response: unknown,
  providerName: string,
  modelName?: string
): ProviderResponse {
  if (typeof response !== "object" || response === null) {
    throw new ProviderError({
      category: "malformed_response",
      message: "Provider returned a non-object response.",
      modelName,
      providerName,
      retriable: false,
      summary: "Provider returned malformed data."
    });
  }

  const candidate = response as Partial<ProviderResponse> & {
    kind?: unknown;
    message?: unknown;
    metadata?: unknown;
    toolCalls?: unknown;
    usage?: unknown;
  };

  if (
    candidate.kind !== "final" &&
    candidate.kind !== "retry" &&
    candidate.kind !== "tool_calls"
  ) {
    malformed(providerName, modelName, "Provider response kind is missing or invalid.");
  }

  if (typeof candidate.message !== "string") {
    malformed(providerName, modelName, "Provider response message must be a string.");
  }

  const usage = candidate.usage;
  if (typeof usage !== "object" || usage === null) {
    malformed(providerName, modelName, "Provider usage payload is missing.");
  }

  const usageRecord = usage as unknown as Record<string, unknown>;
  if (
    typeof usageRecord.inputTokens !== "number" ||
    typeof usageRecord.outputTokens !== "number"
  ) {
    malformed(providerName, modelName, "Provider usage tokens must be numeric.");
  }

  if (candidate.metadata !== undefined) {
    assertMetadata(candidate.metadata, providerName, modelName);
  }

  if (candidate.kind === "retry") {
    const retryCandidate = candidate as {
      delayMs?: unknown;
      reason?: unknown;
    };
    if (typeof retryCandidate.reason !== "string" || typeof retryCandidate.delayMs !== "number") {
      malformed(providerName, modelName, "Provider retry response is incomplete.");
    }
  }

  if (candidate.kind === "tool_calls") {
    if (!Array.isArray(candidate.toolCalls)) {
      malformed(providerName, modelName, "Provider tool call response is missing toolCalls.");
    }

    for (const toolCall of candidate.toolCalls) {
      assertToolCall(toolCall, providerName, modelName);
    }
  }

  return candidate as ProviderResponse;
}

export function withRetryCount(
  response: ProviderResponse,
  retryCount: number
): ProviderResponse {
  const metadata: ProviderResponseMetadata = {
    ...(response.metadata ?? {}),
    retryCount
  };

  return {
    ...response,
    metadata
  };
}

function assertMetadata(
  metadata: unknown,
  providerName: string,
  modelName?: string
): asserts metadata is ProviderResponseMetadata {
  if (typeof metadata !== "object" || metadata === null) {
    malformed(providerName, modelName, "Provider metadata must be an object.");
  }

  const metadataRecord = metadata as Record<string, unknown>;
  if (
    metadataRecord.retryCount !== undefined &&
    typeof metadataRecord.retryCount !== "number"
  ) {
    malformed(providerName, modelName, "Provider metadata retryCount must be numeric.");
  }
}

function assertToolCall(
  toolCall: unknown,
  providerName: string,
  modelName?: string
): asserts toolCall is ProviderToolCall {
  if (typeof toolCall !== "object" || toolCall === null) {
    malformed(providerName, modelName, "Provider tool call must be an object.");
  }

  const candidate = toolCall as Partial<ProviderToolCall> & {
    input?: unknown;
  };

  if (
    typeof candidate.toolCallId !== "string" ||
    typeof candidate.toolName !== "string" ||
    typeof candidate.reason !== "string"
  ) {
    malformed(providerName, modelName, "Provider tool call is missing required fields.");
  }

  if (!isJsonObject(candidate.input)) {
    malformed(providerName, modelName, "Provider tool call input must be an object.");
  }
}

function malformed(providerName: string, modelName: string | undefined, message: string): never {
  throw new ProviderError({
    category: "malformed_response",
    message,
    modelName,
    providerName,
    retriable: false,
    summary: "Provider returned malformed data."
  });
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
