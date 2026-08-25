import type {
  JsonObject,
  Provider,
  ProviderConfig,
  ProviderDescriptor,
  ProviderHealthCheck,
  ProviderRequest,
  ProviderResponse,
  ProviderToolCall,
  ProviderUsage
} from "../types/index.js";
import {
  ANTHROPIC_PROMPT_CACHING_BETA,
  anthropicRequestUsesPromptCache,
  buildAnthropicCompatibleRequestBody
} from "./anthropic-request.js";

import type { ProviderError } from "./provider-error.js";
import {
  classifyProviderHttpError,
  createProviderError,
  isRetriableCategory,
  toProviderError
} from "./provider-runtime.js";
import { composeAbortSignal, ensureTrailingSlash } from "./provider-http.js";
import { missingApiKeyMessage } from "./provider-setup-guidance.js";
import {
  StreamingFallbackState,
  classifyStreamingFallback,
  describeStreamingFallbackReason,
  shouldFallbackFromEmptyStream
} from "./streaming-fallback.js";

interface AnthropicCompatibleResponse {
  content?: Array<
    | {
        text?: string;
        type: "text";
      }
    | {
        id?: string;
        input?: JsonObject;
        name?: string;
        type: "tool_use";
      }
  >;
  error?: {
    message?: string;
    type?: string;
  };
  id?: string;
  model?: string;
  stop_reason?: string | null;
  type?: string;
  usage?: AnthropicUsageFields;
}

interface AnthropicUsageFields {
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

interface AnthropicModelsResponse {
  data?: Array<{
    id?: string;
  }>;
  error?: {
    message?: string;
    type?: string;
  };
}

interface AnthropicStreamEvent {
  content_block?: {
    id?: string;
    input?: JsonObject;
    name?: string;
    text?: string;
    type?: "text" | "tool_use";
  };
  delta?: {
    partial_json?: string;
    stop_reason?: string | null;
    text?: string;
    type?: "input_json_delta" | "text_delta";
  };
  index?: number;
  message?: {
    id?: string;
    model?: string;
    usage?: AnthropicUsageFields;
  };
  type?: string;
  usage?: AnthropicUsageFields;
}

export class AnthropicCompatibleProvider implements Provider {
  public readonly capabilities = {
    streaming: true,
    textGeneration: true,
    toolCalls: true
  } as const;

  public readonly model: string;
  public readonly name: string;
  private readonly streamingFallback = new StreamingFallbackState();

  public constructor(
    protected readonly config: ProviderConfig,
    private readonly options: {
      anthropicVersion?: string;
      defaultBaseUrl: string | null;
      defaultDisplayName: string;
      defaultModel: string;
      providerLabel?: string;
    }
  ) {
    this.name = config.name;
    this.model = config.model ?? options.defaultModel;
  }

  public describe(): ProviderDescriptor {
    return {
      baseUrl: this.resolveBaseUrl(),
      capabilities: this.capabilities,
      contextWindowTokens: this.config.contextWindowTokens ?? null,
      displayName: this.options.providerLabel ?? this.options.defaultDisplayName,
      model: this.model,
      name: this.name
    };
  }

  public fetchContextWindow(): Promise<number | null> {
    return Promise.resolve(null);
  }

  public async generate(input: ProviderRequest): Promise<ProviderResponse> {
    this.ensureConfigured();
    if (input.onTextDelta !== undefined && this.capabilities.streaming && !this.streamingFallback.isStreamingDisabled()) {
      return this.generateStreamingWithFallback(input);
    }

    return this.generateComplete(input);
  }

  private async generateComplete(input: ProviderRequest): Promise<ProviderResponse> {
    const response = await this.requestJson<AnthropicCompatibleResponse>(
      "v1/messages",
      this.buildRequestBody(input),
      input.signal
    );

    if (response.error !== undefined) {
      const category = classifyProviderHttpError(undefined, response.error.type);
      throw createProviderError({
        category,
        details: sanitizeErrorDetails(response.error),
        message: response.error.message ?? `${this.describe().displayName} returned an unknown error.`,
        modelName: this.model,
        providerName: this.name,
        retriable: isRetriableCategory(category),
        summary: summarizeProviderCategory(category)
      });
    }

    const toolCalls = (response.content ?? [])
      .map((block, index) => parseToolCall(block, index, this.name))
      .filter((toolCall): toolCall is ProviderToolCall => toolCall !== null);
    const message = (response.content ?? [])
      .filter((block): block is Extract<NonNullable<AnthropicCompatibleResponse["content"]>[number], { type: "text" }> => block.type === "text")
      .map((block) => block.text?.trim() ?? "")
      .filter((block) => block.length > 0)
      .join("\n");
    const metadata = {
      finishReason: response.stop_reason ?? null,
      modelName: response.model ?? this.model,
      providerName: this.name,
      raw: sanitizeRawMetadata(response),
      requestId: response.id ?? null,
      retryCount: 0
    };
    const usage = toUsage(response.usage);

    if (toolCalls.length > 0) {
      return {
        kind: "tool_calls",
        message,
        metadata,
        toolCalls,
        usage
      };
    }

    return {
      kind: "final",
      message,
      metadata,
      usage
    };
  }

  private async generateStreamingWithFallback(input: ProviderRequest): Promise<ProviderResponse> {
    const progress = { emittedText: false, madeProgress: false, sawEvent: false };
    try {
      const response = await this.generateStreaming(input, progress);
      if (shouldFallbackFromEmptyStream(response, progress)) {
        this.streamingFallback.recordFailure(
          input,
          "transient",
          "streaming response contained no usable events",
          (req, reason) => this.emitStreamingFallbackNotice(req, reason)
        );
        return this.generateComplete(input);
      }
      this.streamingFallback.recordSuccess();
      return response;
    } catch (error) {
      const fallbackKind = classifyStreamingFallback(error);
      if (fallbackKind === "ineligible") {
        throw error;
      }
      this.streamingFallback.recordFailure(
        input,
        fallbackKind,
        describeStreamingFallbackReason(error),
        (req, reason) => this.emitStreamingFallbackNotice(req, reason)
      );
      return this.generateComplete(input);
    }
  }

  public async testConnection(signal?: AbortSignal): Promise<ProviderHealthCheck> {
    const apiKeyConfigured = this.config.apiKey !== null && this.config.apiKey.length > 0;
    const modelConfigured = this.model.length > 0;

    if (!apiKeyConfigured) {
      return {
        apiKeyConfigured,
        endpointReachable: null,
        message: missingApiKeyMessage(this.describe().displayName, this.name),
        modelAvailable: null,
        modelConfigured,
        modelName: this.model,
        ok: false,
        providerName: this.name
      };
    }

    const startedAt = Date.now();

    try {
      const response = await this.requestJson<AnthropicModelsResponse>(
        "v1/models",
        undefined,
        signal,
        "GET"
      );
      const latencyMs = Date.now() - startedAt;
      const availableModels = response.data?.map((entry) => entry.id).filter(isNonEmptyString) ?? [];
      const modelAvailable = availableModels.length === 0 ? null : availableModels.includes(this.model);

      return {
        apiKeyConfigured,
        endpointReachable: true,
        latencyMs,
        message:
          modelAvailable === false
            ? `Connected to ${this.describe().displayName}, but model ${this.model} was not listed by /v1/models.`
            : `${this.describe().displayName} endpoint reachable and authentication succeeded.`,
        modelAvailable,
        modelConfigured,
        modelName: this.model,
        ok: modelConfigured && modelAvailable !== false,
        providerName: this.name
      };
    } catch (error) {
      const providerError = toProviderError(error, this.name, this.model);
      return {
        apiKeyConfigured,
        endpointReachable: providerError.category !== "transient_network_error",
        errorCategory: providerError.category,
        latencyMs: Date.now() - startedAt,
        message: providerError.message,
        modelAvailable: null,
        modelConfigured,
        modelName: this.model,
        ok: false,
        providerName: this.name
      };
    }
  }

  protected resolveBaseUrl(): string | null {
    return this.config.baseUrl ?? this.options.defaultBaseUrl;
  }

  private async generateStreaming(
    input: ProviderRequest,
    progress: { emittedText: boolean; madeProgress: boolean; sawEvent: boolean }
  ): Promise<ProviderResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const body = this.buildRequestBody(input, { stream: true });
    try {
      const response = await fetch(
        new URL("v1/messages", ensureTrailingSlash(this.resolveBaseUrl())).toString(),
        {
          body: JSON.stringify(body),
          headers: this.buildHeaders(anthropicRequestUsesPromptCache(body)),
          method: "POST",
          signal: composeAbortSignal(input.signal, controller.signal)
        }
      );
      if (!response.ok) {
        const text = await response.text();
        const parsed = parseJson<AnthropicCompatibleResponse>(text, this.name, this.model);
        const category = classifyProviderHttpError(
          response.status,
          readErrorType(parsed),
          readErrorCode(parsed)
        );
        throw createProviderError({
          category,
          message:
            extractErrorMessage(parsed) ??
            `${this.describe().displayName} streaming request failed with status ${response.status}.`,
          modelName: this.model,
          providerName: this.name,
          retriable: isRetriableCategory(category),
          statusCode: response.status,
          summary: summarizeProviderCategory(category)
        });
      }
      if (response.body === null) {
        throw createProviderError({
          category: "malformed_response",
          message: "Provider returned an empty streaming body.",
          modelName: this.model,
          providerName: this.name,
          retriable: false,
          summary: "The provider response stream was missing."
        });
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const textBlocks = new Map<number, string>();
      const toolBlocks = new Map<number, { id: string; input: string; name: string }>();
      let buffer = "";
      let id: string | null = null;
      let model = this.model;
      let stopReason: string | null = null;
      let usage: ProviderUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      const readNextChunk = (): Promise<ReadableStreamReadResult<Uint8Array>> =>
        new Promise((resolve, reject) => {
          const idleTimeout = setTimeout(() => {
            controller.abort();
            reject(new DOMException("Streaming provider response became idle.", "AbortError"));
          }, this.config.streamIdleTimeoutMs ?? this.config.timeoutMs);

          reader.read().then(
            (chunk) => {
              clearTimeout(idleTimeout);
              resolve(chunk);
            },
            (error: unknown) => {
              clearTimeout(idleTimeout);
              const causeMessage = error instanceof Error ? error.message : null;
              reject(
                new Error(
                  causeMessage === null || causeMessage.length === 0
                    ? "Streaming provider read failed."
                    : `Streaming provider read failed: ${causeMessage}`
                )
              );
            }
          );
        });

      const handlePayload = (payload: string): void => {
        if (payload.trim().length === 0) {
          return;
        }
        const event = parseJson<AnthropicStreamEvent>(payload, this.name, this.model);
        progress.sawEvent = true;
        if (event.type === "message_start") {
          id = event.message?.id ?? id;
          model = event.message?.model ?? model;
          usage = toUsage(event.message?.usage);
          return;
        }
        if (event.type === "content_block_start" && event.index !== undefined) {
          if (event.content_block?.type === "text") {
            textBlocks.set(event.index, event.content_block.text ?? "");
          }
          if (event.content_block?.type === "tool_use") {
            progress.madeProgress = true;
            toolBlocks.set(event.index, {
              id: event.content_block.id ?? "",
              input:
                event.content_block.input !== undefined &&
                Object.keys(event.content_block.input).length > 0
                  ? JSON.stringify(event.content_block.input)
                  : "",
              name: event.content_block.name ?? ""
            });
          }
          return;
        }
        if (event.type === "content_block_delta" && event.index !== undefined) {
          if (event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
            if (event.delta.text.length > 0) {
              progress.emittedText = true;
              progress.madeProgress = true;
            }
            textBlocks.set(event.index, `${textBlocks.get(event.index) ?? ""}${event.delta.text}`);
            input.onTextDelta?.(event.delta.text);
          }
          if (event.delta?.type === "input_json_delta" && typeof event.delta.partial_json === "string") {
            const block = toolBlocks.get(event.index);
            if (block !== undefined) {
              progress.madeProgress = true;
              block.input += event.delta.partial_json;
            }
          }
          return;
        }
        if (event.type === "message_delta") {
          stopReason = event.delta?.stop_reason ?? stopReason;
          const outputTokens = event.usage?.output_tokens ?? usage.outputTokens;
          usage = {
            ...usage,
            ...toUsage({
              input_tokens: usage.inputTokens,
              output_tokens: outputTokens,
              ...(usage.cachedInputTokens !== undefined
                ? { cache_read_input_tokens: usage.cachedInputTokens }
                : {})
            })
          };
        }
      };

      while (true) {
        const chunk = await readNextChunk();
        if (chunk.done) {
          break;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/u);
        buffer = events.pop() ?? "";
        for (const eventText of events) {
          const payload = eventText
            .split(/\r?\n/u)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice("data:".length).trim())
            .join("\n");
          handlePayload(payload);
        }
      }
      if (buffer.trim().length > 0) {
        const payload = buffer
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trim())
          .join("\n");
        handlePayload(payload);
      }

      const message = [...textBlocks.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, value]) => value.trim())
        .filter((value) => value.length > 0)
        .join("\n");
      const toolCalls = [...toolBlocks.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, block], index) => parseStreamToolCall(block, index, this.name));
      const metadata = {
        finishReason: stopReason,
        modelName: model,
        providerName: this.name,
        raw: {
          contentCount: textBlocks.size + toolBlocks.size,
          id,
          stopReason,
          type: "message_stream"
        },
        requestId: id,
        retryCount: 0
      };
      return toolCalls.length > 0
        ? { kind: "tool_calls", message, metadata, toolCalls, usage }
        : { kind: "final", message, metadata, usage };
    } catch (error) {
      throw toProviderError(error, this.name, this.model);
    } finally {
      clearTimeout(timeout);
    }
  }

  private ensureConfigured(): void {
    if (this.config.apiKey === null || this.config.apiKey.length === 0) {
      throw createProviderError({
        category: "auth_error",
        message: `${this.describe().displayName} API key is not configured.`,
        modelName: this.model,
        providerName: this.name,
        retriable: false,
        summary: `Authentication is not configured for the ${this.describe().displayName} provider.`
      });
    }

    const baseUrl = this.resolveBaseUrl();
    if (baseUrl === null || baseUrl.length === 0) {
      throw createProviderError({
        category: "invalid_request",
        message: `${this.describe().displayName} base URL is not configured.`,
        modelName: this.model,
        providerName: this.name,
        retriable: false,
        summary: `The ${this.describe().displayName} provider configuration is incomplete.`
      });
    }
  }

  private async requestJson<TResponse>(
    path: string,
    body: JsonObject | undefined,
    signal: AbortSignal | undefined,
    method = "POST"
  ): Promise<TResponse> {
    this.ensureConfigured();

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.config.timeoutMs);

    try {
      const init: RequestInit = {
        headers: this.buildHeaders(anthropicRequestUsesPromptCache(body)),
        method,
        signal: composeAbortSignal(signal, controller.signal)
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }

      const response = await fetch(
        new URL(path, ensureTrailingSlash(this.resolveBaseUrl())).toString(),
        init
      );
      const text = await response.text();
      const parsed = parseJson<TResponse>(text, this.name, this.model);

      if (!response.ok) {
        const category = classifyProviderHttpError(
          response.status,
          readErrorType(parsed),
          readErrorCode(parsed)
        );
        throw createProviderError({
          category,
          details: {
            status: response.status
          },
          message:
            extractErrorMessage(parsed) ??
            `${this.describe().displayName} request failed with status ${response.status}.`,
          modelName: this.model,
          providerName: this.name,
          retriable: isRetriableCategory(category),
          statusCode: response.status,
          summary: summarizeProviderCategory(category)
        });
      }

      return parsed;
    } catch (error) {
      throw toProviderError(error, this.name, this.model);
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildRequestBody(input: ProviderRequest, extras: { stream?: boolean } = {}) {
    return buildAnthropicCompatibleRequestBody(input, this.model, extras);
  }

  private buildHeaders(promptCache = false): Record<string, string> {
    const headers: Record<string, string> = {
      "anthropic-version": this.options.anthropicVersion ?? "2023-06-01",
      "Content-Type": "application/json"
    };
    if (this.config.apiKey !== null) {
      headers["x-api-key"] = this.config.apiKey;
    }
    if (promptCache) {
      headers["anthropic-beta"] = ANTHROPIC_PROMPT_CACHING_BETA;
    }
    return headers;
  }

  private emitStreamingFallbackNotice(input: ProviderRequest, reason: string): void {
    input.onProviderStatus?.({
      kind: "streaming_fallback",
      message: `${this.describe().displayName} streaming unavailable; continuing with complete-only responses.`,
      modelName: this.model,
      providerName: this.name,
      reason
    });
  }
}

function parseToolCall(
  block: NonNullable<AnthropicCompatibleResponse["content"]>[number],
  index: number,
  providerName: string
): ProviderToolCall | null {
  if (block.type !== "tool_use") {
    return null;
  }

  if (!isNonEmptyString(block.id) || !isNonEmptyString(block.name) || !isJsonObject(block.input)) {
    throw createProviderError({
      category: "malformed_response",
      details: {
        index
      },
      message: "Provider returned an invalid tool call payload.",
      providerName,
      retriable: false,
      summary: "The provider returned malformed tool call data."
    });
  }

  return {
    input: block.input,
    raw: {
      index
    },
    reason: `Provider ${block.name} tool call requested.`,
    toolCallId: block.id,
    toolName: block.name
  };
}

function parseStreamToolCall(
  block: { id: string; input: string; name: string },
  index: number,
  providerName: string
): ProviderToolCall {
  let input: unknown;
  try {
    input = JSON.parse(block.input.length > 0 ? block.input : "{}");
  } catch (error) {
    throw createProviderError({
      category: "malformed_response",
      cause: error,
      details: { index },
      message: "Provider streamed invalid tool input JSON.",
      providerName,
      retriable: false,
      summary: "The provider streamed malformed tool call input."
    });
  }
  if (!isNonEmptyString(block.id) || !isNonEmptyString(block.name) || !isJsonObject(input)) {
    throw createProviderError({
      category: "malformed_response",
      details: { index },
      message: "Provider streamed an invalid tool call payload.",
      providerName,
      retriable: false,
      summary: "The provider streamed malformed tool call data."
    });
  }
  return {
    input,
    raw: { index },
    reason: `Provider ${block.name} tool call requested.`,
    toolCallId: block.id,
    toolName: block.name
  };
}

function toUsage(usage: AnthropicUsageFields | undefined): ProviderUsage {
  const mapped: ProviderUsage = {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    totalTokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0)
  };
  const cachedInputTokens = usage?.cache_read_input_tokens;
  if (typeof cachedInputTokens === "number" && Number.isFinite(cachedInputTokens) && cachedInputTokens >= 0) {
    mapped.cachedInputTokens = cachedInputTokens;
  }
  return mapped;
}

function sanitizeRawMetadata(response: AnthropicCompatibleResponse): JsonObject {
  return {
    contentCount: response.content?.length ?? 0,
    id: response.id ?? null,
    stopReason: response.stop_reason ?? null,
    type: response.type ?? null
  };
}

function sanitizeErrorDetails(error: { type?: string }): JsonObject {
  return {
    type: error.type ?? null
  };
}

function readErrorType(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as { error?: { type?: string } };
  return record.error?.type;
}

function readErrorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as { error?: { code?: string } };
  return record.error?.code;
}

function extractErrorMessage(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const maybeError = (value as { error?: { message?: string } }).error;
  if (typeof maybeError?.message === "string" && maybeError.message.length > 0) {
    return maybeError.message;
  }

  return null;
}

function parseJson<TResponse>(
  text: string,
  providerName: string,
  modelName: string
): TResponse {
  if (text.length === 0) {
    return {} as TResponse;
  }

  try {
    return JSON.parse(text) as TResponse;
  } catch (error) {
    throw createProviderError({
      category: "malformed_response",
      cause: error,
      message: "Provider returned invalid JSON.",
      modelName,
      providerName,
      retriable: false,
      summary: "The provider response could not be parsed as JSON."
    });
  }
}

function summarizeProviderCategory(category: ProviderError["category"]): string {
  switch (category) {
    case "auth_error":
      return "Authentication failed for the provider request.";
    case "invalid_request":
      return "The provider rejected the request payload.";
    case "malformed_response":
      return "The provider response could not be interpreted safely.";
    case "provider_unavailable":
      return "The provider endpoint is unavailable.";
    case "rate_limit":
      return "The provider rejected the request because of rate limits.";
    case "timeout_error":
      return "The provider request timed out.";
    case "transient_network_error":
      return "A transient network error interrupted the provider request.";
    case "unsupported_capability":
      return "The provider does not support the requested capability.";
    default:
      return "The provider request failed.";
  }
}

function isNonEmptyString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
