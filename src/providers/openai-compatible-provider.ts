import type {
  ConversationMessage,
  JsonObject,
  Provider,
  ProviderCapabilities,
  ProviderConfig,
  ProviderDescriptor,
  ProviderHealthCheck,
  ProviderRequest,
  ProviderResponse,
  ProviderToolCall,
  ProviderToolDescriptor,
  ProviderUsage
} from "../types/index.js";

import type { ProviderError } from "./provider-error.js";
import {
  classifyProviderHttpError,
  createProviderError,
  isRetriableCategory,
  toProviderError
} from "./provider-runtime.js";
import {
  CONTEXT_WINDOW_FETCH_TIMEOUT_MS,
  parseContextLengthFromModelEntry,
  parseContextLengthFromOllamaModelInfo,
  parseContextLengthFromOllamaParameters,
  resolveOllamaShowUrl
} from "./context-window-query.js";
import { composeAbortSignal, ensureTrailingSlash } from "./provider-http.js";
import { missingApiKeyMessage } from "./provider-setup-guidance.js";
import {
  parseReasoningContent,
  reasoningContentForReplay
} from "./reasoning-content.js";
import { isPrimarilyTextToolCallMarkup, parseTextToolCalls } from "./text-tool-call-parser.js";
import { normalizeOpenAiCompatibleMessages } from "./openai-message-sanitizer.js";
import { parseOpenAiCompatibleUsage } from "./openai-usage.js";
import {
  StreamingFallbackState,
  classifyStreamingFallback,
  describeStreamingFallbackReason,
  shouldFallbackFromEmptyStream
} from "./streaming-fallback.js";

interface OpenAiCompatibleTool {
  function: {
    description: string;
    name: string;
    parameters: JsonObject;
  };
  type: "function";
}

interface OpenAiCompatibleMessage extends JsonObject {
  content: string | null;
  reasoning_content?: string;
  role: "assistant" | "system" | "tool" | "user";
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    function: {
      arguments: string;
      name: string;
    };
    type: "function";
  }>;
}

interface OpenAiCompatibleResponse {
  choices?: Array<{
    finish_reason?: string | null;
    index: number;
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      role?: string;
      tool_calls?: Array<{
        id?: string;
        function?: {
          arguments?: string;
          name?: string;
        };
        type?: string;
      }>;
    };
  }>;
  id?: string;
  model?: string;
  usage?: {
    cached_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    total_tokens?: number;
  };
  error?: {
    code?: string;
    message?: string;
    type?: string;
  };
}

export class OpenAiCompatibleProvider implements Provider {
  public readonly capabilities: ProviderCapabilities;

  public readonly model: string;
  public readonly name: string;
  private readonly streamingFallback = new StreamingFallbackState();

  public constructor(
    protected readonly config: ProviderConfig,
    private readonly options: {
      defaultBaseUrl: string | null;
      defaultDisplayName: string;
      defaultModel: string;
      providerName?: string;
      providerLabel?: string;
      supportsStreaming?: boolean;
    }
  ) {
    this.name = options.providerName ?? config.name;
    this.model = config.model ?? options.defaultModel;
    this.capabilities = {
      streaming: options.supportsStreaming ?? true,
      textGeneration: true,
      toolCalls: true
    };
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

  public async generate(input: ProviderRequest): Promise<ProviderResponse> {
    this.ensureConfigured();

    if (input.onTextDelta !== undefined && this.capabilities.streaming && !this.streamingFallback.isStreamingDisabled()) {
      return this.generateStreamingWithFallback(input);
    }

    return this.generateComplete(input);
  }

  private mapProviderMessages(input: ProviderRequest): OpenAiCompatibleMessage[] {
    return normalizeOpenAiCompatibleMessages(input.messages).map((message, index, messages) =>
      toProviderMessage(message, messages, index)
    );
  }

  private async generateComplete(input: ProviderRequest): Promise<ProviderResponse> {
    const response = await this.requestJson<OpenAiCompatibleResponse>(
      "chat/completions",
      {
        max_tokens: Math.max(1, input.tokenBudget.outputLimit),
        messages: this.mapProviderMessages(input),
        model: this.model,
        stream: false,
        tools: input.availableTools.map((tool) => toProviderTool(tool) as unknown as JsonObject)
      },
      input.signal
    );

    if (response.error !== undefined) {
      const category = classifyProviderHttpError(undefined, response.error.type, response.error.code);
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

    const choice = response.choices?.[0];
    const message = choice?.message;
    const toolCalls = (message?.tool_calls ?? [])
      .map((toolCall, index) => parseToolCall(toolCall, index, this.name))
      .filter((toolCall): toolCall is ProviderToolCall => toolCall !== null);
    const content = message?.content?.trim() ?? "";
    const reasoningContent = parseReasoningContent(message?.reasoning_content);
    const usage = parseOpenAiCompatibleUsage(response.usage);
    const metadata = {
      finishReason: choice?.finish_reason ?? null,
      modelName: response.model ?? this.model,
      providerName: this.name,
      raw: sanitizeRawMetadata(response),
      requestId: response.id ?? null,
      retryCount: 0
    };

    if (toolCalls.length > 0) {
      return {
        kind: "tool_calls",
        message: content,
        metadata,
        ...(reasoningContent !== undefined ? { reasoningContent } : {}),
        toolCalls,
        usage
      };
    }

    const textToolCalls = isPrimarilyTextToolCallMarkup(content) ? parseTextToolCalls(content) : [];
    if (textToolCalls.length > 0) {
      return {
        kind: "tool_calls",
        message: "",
        metadata,
        ...(reasoningContent !== undefined ? { reasoningContent } : {}),
        toolCalls: textToolCalls,
        usage
      };
    }

    return {
      kind: "final",
      message: content,
      metadata,
      ...(reasoningContent !== undefined ? { reasoningContent } : {}),
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

  private async generateStreaming(
    input: ProviderRequest,
    progress: { emittedText: boolean; madeProgress: boolean; sawEvent: boolean }
  ): Promise<ProviderResponse> {
    this.ensureConfigured();

    const controller = new AbortController();
    const requestTimeout = setTimeout(() => {
      controller.abort();
    }, this.config.timeoutMs);

    try {
      const init: RequestInit = {
        body: JSON.stringify({
          max_tokens: Math.max(1, input.tokenBudget.outputLimit),
          messages: this.mapProviderMessages(input),
          model: this.model,
          stream: true,
          tools: input.availableTools.map((tool) => toProviderTool(tool) as unknown as JsonObject)
        }),
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json"
        },
        method: "POST",
        signal: composeAbortSignal(input.signal, controller.signal)
      };

      const response = await fetch(
        new URL("chat/completions", ensureTrailingSlash(this.resolveBaseUrl())).toString(),
        init
      );
      clearTimeout(requestTimeout);

      if (!response.ok) {
        const text = await response.text();
        let parsed: { error?: { message?: string; type?: string; code?: string } } = {};
        try {
          parsed = text.length === 0 ? {} : (JSON.parse(text) as typeof parsed);
        } catch {
          parsed = {};
        }
        const category = classifyProviderHttpError(response.status);
        throw createProviderError({
          category,
          details: { status: response.status },
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

      const reader = response.body?.getReader();
      if (reader === undefined) {
        throw createProviderError({
          category: "unknown_error",
          message: "Streaming response had no body.",
          modelName: this.model,
          providerName: this.name,
          retriable: false,
          summary: "The provider returned an empty streaming body."
        });
      }

      let buffer = "";
      let fullContent = "";
      let fullReasoningContent = "";
      const toolParts = new Map<number, { arguments: string; id: string; name: string }>();
      let lastUsage: ProviderUsage | undefined;
      const decoder = new TextDecoder();
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
      const handleSseLine = (line: string): void => {
        const trimmed = line.trim();
        if (trimmed.length === 0 || !trimmed.startsWith("data:")) {
          return;
        }
        const dataStr = trimmed.slice("data:".length).trim();
        if (dataStr === "[DONE]") {
          return;
        }
        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(dataStr) as Record<string, unknown>;
        } catch {
          return;
        }
        progress.sawEvent = true;
        const usageRaw = chunk["usage"] as
          | {
              cached_tokens?: number;
              completion_tokens?: number;
              prompt_cache_hit_tokens?: number;
              prompt_tokens?: number;
              prompt_tokens_details?: { cached_tokens?: number };
              total_tokens?: number;
            }
          | undefined;
        if (usageRaw !== undefined) {
          lastUsage = parseOpenAiCompatibleUsage(usageRaw);
        }

        const choices = chunk["choices"] as Array<{ delta?: Record<string, unknown> }> | undefined;
        const choice = choices?.[0];
        const delta = choice?.delta as
          | {
              content?: string;
              reasoning_content?: string;
              tool_calls?: Array<{
                function?: { arguments?: string; name?: string };
                id?: string;
                index?: number;
              }>;
            }
          | undefined;
        if (delta === undefined) {
          return;
        }

        if (typeof delta.content === "string" && delta.content.length > 0) {
          progress.emittedText = true;
          progress.madeProgress = true;
          fullContent += delta.content;
          input.onTextDelta?.(delta.content);
        }

        if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
          progress.madeProgress = true;
          fullReasoningContent += delta.reasoning_content;
        }

        if (Array.isArray(delta.tool_calls)) {
          if (delta.tool_calls.length > 0) {
            progress.madeProgress = true;
          }
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === "number" ? tc.index : 0;
            const cur = toolParts.get(idx) ?? { arguments: "", id: "", name: "" };
            if (typeof tc.id === "string" && tc.id.length > 0) {
              cur.id = tc.id;
            }
            if (typeof tc.function?.name === "string" && tc.function.name.length > 0) {
              cur.name = tc.function.name;
            }
            if (typeof tc.function?.arguments === "string") {
              cur.arguments += tc.function.arguments;
            }
            toolParts.set(idx, cur);
          }
        }
      };

      while (true) {
        const chunk = await readNextChunk();
        const { done, value } = chunk;
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          handleSseLine(line);
        }
      }
      buffer += decoder.decode();
      for (const line of buffer.split("\n")) {
        handleSseLine(line);
      }

      const usage =
        lastUsage ??
        ({
          inputTokens: 0,
          outputTokens: 0
        } as ProviderUsage);

      const metadata = {
        finishReason: null,
        modelName: this.model,
        providerName: this.name,
        raw: { streamed: true },
        requestId: null,
        retryCount: 0
      };

      const sorted = [...toolParts.entries()].sort(([a], [b]) => a - b);
      const toolCalls: ProviderToolCall[] = [];
      for (const [, parts] of sorted) {
        if (parts.name.length === 0 || parts.id.length === 0) {
          continue;
        }
        toolCalls.push({
          input: parseToolArguments(parts.arguments.length > 0 ? parts.arguments : "{}", this.name),
          raw: {
            arguments: parts.arguments,
            streamed: true
          },
          reason: `Provider ${parts.name} tool call requested.`,
          toolCallId: parts.id,
          toolName: parts.name
        });
      }

      const content = fullContent.trim();
      const reasoningContent =
        fullReasoningContent.length > 0 ? fullReasoningContent : undefined;

      if (toolCalls.length > 0) {
        return {
          kind: "tool_calls",
          message: content,
          metadata,
          ...(reasoningContent !== undefined ? { reasoningContent } : {}),
          toolCalls,
          usage
        };
      }

      const textToolCalls = isPrimarilyTextToolCallMarkup(content) ? parseTextToolCalls(content) : [];
      if (textToolCalls.length > 0) {
        return {
          kind: "tool_calls",
          message: "",
          metadata,
          ...(reasoningContent !== undefined ? { reasoningContent } : {}),
          toolCalls: textToolCalls,
          usage
        };
      }

      return {
        kind: "final",
        message: content,
        metadata,
        ...(reasoningContent !== undefined ? { reasoningContent } : {}),
        usage
      };
    } catch (error) {
      throw toProviderError(error, this.name, this.model);
    } finally {
      clearTimeout(requestTimeout);
    }
  }

  public async fetchContextWindow(signal?: AbortSignal): Promise<number | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, CONTEXT_WINDOW_FETCH_TIMEOUT_MS);
    const composedSignal = composeAbortSignal(signal, controller.signal);

    try {
      const fromModels = await this.queryContextWindowFromModels(composedSignal);
      if (fromModels !== null) {
        return fromModels;
      }
      return await this.queryContextWindowFromOllamaShow(composedSignal);
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
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
      const response = await this.requestJson<{ data?: Array<{ id?: string }> }>(
        "models",
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
            ? `Connected to ${this.describe().displayName}, but model ${this.model} was not listed by /models.`
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

  private async queryContextWindowFromModels(signal?: AbortSignal): Promise<number | null> {
    const response = await this.requestJson<{ data?: Array<Record<string, unknown>> }>(
      "models",
      undefined,
      signal,
      "GET"
    );
    const entry = response.data?.find((candidate) => candidate.id === this.model);
    if (entry === undefined) {
      return null;
    }
    return parseContextLengthFromModelEntry(entry);
  }

  private async queryContextWindowFromOllamaShow(signal?: AbortSignal): Promise<number | null> {
    const baseUrl = this.resolveBaseUrl();
    if (baseUrl === null || baseUrl.length === 0) {
      return null;
    }

    const showUrl = resolveOllamaShowUrl(baseUrl);
    if (showUrl === null) {
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, CONTEXT_WINDOW_FETCH_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json"
      };
      if (this.config.apiKey !== null && this.config.apiKey.length > 0) {
        headers.Authorization = `Bearer ${this.config.apiKey}`;
      }

      const response = await fetch(showUrl, {
        body: JSON.stringify({ model: this.model }),
        headers,
        method: "POST",
        signal: composeAbortSignal(signal, controller.signal)
      });
      if (!response.ok) {
        return null;
      }

      const parsed = (await response.json()) as {
        model_info?: Record<string, unknown>;
        parameters?: string;
      };
      if (parsed.model_info !== undefined) {
        const fromModelInfo = parseContextLengthFromOllamaModelInfo(parsed.model_info);
        if (fromModelInfo !== null) {
          return fromModelInfo;
        }
      }
      if (typeof parsed.parameters === "string") {
        return parseContextLengthFromOllamaParameters(parsed.parameters);
      }
      return null;
    } catch {
      return null;
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
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json"
        },
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
      const parsed = (text.length === 0 ? {} : JSON.parse(text)) as TResponse;

      if (!response.ok) {
        const category = classifyProviderHttpError(response.status);
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

function toProviderMessage(
  message: ConversationMessage,
  messages: ConversationMessage[],
  messageIndex: number
): OpenAiCompatibleMessage {
  const content = typeof message.content === "string" ? message.content : "";
  const replayedReasoning = reasoningContentForReplay(message, messages, messageIndex);
  if (message.role === "assistant" && message.toolCalls !== undefined && message.toolCalls.length > 0) {
    return {
      content: content.length > 0 ? content : null,
      role: "assistant",
      ...(replayedReasoning !== undefined ? { reasoning_content: replayedReasoning } : {}),
      tool_calls: message.toolCalls.map((toolCall) => ({
        function: {
          arguments: JSON.stringify(toolCall.input),
          name: toolCall.toolName
        },
        id: toolCall.toolCallId,
        type: "function"
      }))
    };
  }

  if (message.role === "tool") {
    return {
      content,
      role: "tool",
      ...(message.toolCallId !== undefined ? { tool_call_id: message.toolCallId } : {})
    };
  }

  if (message.role === "assistant" && replayedReasoning !== undefined) {
    return {
      content,
      reasoning_content: replayedReasoning,
      role: "assistant"
    };
  }

  return {
    content,
    role: message.role
  };
}

function toProviderTool(tool: ProviderToolDescriptor): OpenAiCompatibleTool {
  return {
    function: {
      description: tool.description,
      name: tool.name,
      parameters: tool.inputSchema
    },
    type: "function"
  };
}

function parseToolCall(
  toolCall: {
    id?: string;
    function?: {
      arguments?: string;
      name?: string;
    };
    type?: string;
  },
  index: number,
  providerName: string
): ProviderToolCall | null {
  const id = toolCall.id;
  const name = toolCall.function?.name;
  const rawArguments = toolCall.function?.arguments;
  if (!isNonEmptyString(id) || !isNonEmptyString(name) || !isNonEmptyString(rawArguments)) {
    return null;
  }

  return {
    input: parseToolArguments(rawArguments, providerName),
    raw: {
      arguments: rawArguments,
      index
    },
    reason: `Provider ${name} tool call requested.`,
    toolCallId: id,
    toolName: name
  };
}

function parseToolArguments(rawArguments: string, providerName: string): JsonObject {
  try {
    const parsed = JSON.parse(rawArguments) as JsonObject;
    return parsed;
  } catch (error) {
    throw createProviderError({
      category: "malformed_response",
      details: {
        rawArguments
      },
      message: "Provider returned invalid tool call arguments.",
      providerName,
      retriable: false,
      cause: error,
      summary: "The provider returned malformed tool call arguments."
    });
  }
}

function sanitizeRawMetadata(response: OpenAiCompatibleResponse): JsonObject {
  return {
    choiceCount: response.choices?.length ?? 0,
    finishReason: response.choices?.[0]?.finish_reason ?? null,
    id: response.id ?? null
  };
}

function sanitizeErrorDetails(error: { code?: string; type?: string }): JsonObject {
  return {
    code: error.code ?? null,
    type: error.type ?? null
  };
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

function isNonEmptyString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
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
