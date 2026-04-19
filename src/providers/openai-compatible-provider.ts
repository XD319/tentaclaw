import type {
  ConversationMessage,
  JsonObject,
  Provider,
  ProviderConfig,
  ProviderDescriptor,
  ProviderHealthCheck,
  ProviderRequest,
  ProviderResponse,
  ProviderToolCall,
  ProviderToolDescriptor,
  ProviderUsage
} from "../types";

import type { ProviderError } from "./provider-error";
import {
  classifyProviderHttpError,
  createProviderError,
  isRetriableCategory,
  toProviderError
} from "./provider-runtime";

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
    completion_tokens?: number;
    prompt_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    code?: string;
    message?: string;
    type?: string;
  };
}

export class OpenAiCompatibleProvider implements Provider {
  public readonly capabilities = {
    streaming: true,
    textGeneration: true,
    toolCalls: true
  } as const;

  public readonly model: string;
  public readonly name: string;

  public constructor(
    protected readonly config: ProviderConfig,
    private readonly options: {
      defaultBaseUrl: string | null;
      defaultDisplayName: string;
      defaultModel: string;
      providerName?: string;
      providerLabel?: string;
    }
  ) {
    this.name = options.providerName ?? config.name;
    this.model = config.model ?? options.defaultModel;
  }

  public describe(): ProviderDescriptor {
    return {
      baseUrl: this.resolveBaseUrl(),
      capabilities: this.capabilities,
      displayName: this.options.providerLabel ?? this.options.defaultDisplayName,
      model: this.model,
      name: this.name
    };
  }

  public async generate(input: ProviderRequest): Promise<ProviderResponse> {
    this.ensureConfigured();

    if (input.onTextDelta !== undefined) {
      return this.generateStreaming(input);
    }

    const response = await this.requestJson<OpenAiCompatibleResponse>(
      "chat/completions",
      {
        messages: input.messages.map((message) => toProviderMessage(message)),
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
    const usage = toUsage(response.usage);
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
        message: content.length > 0 ? content : "Provider requested tool execution.",
        metadata,
        toolCalls,
        usage
      };
    }

    return {
      kind: "final",
      message: content,
      metadata,
      usage
    };
  }

  private async generateStreaming(input: ProviderRequest): Promise<ProviderResponse> {
    this.ensureConfigured();

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.config.timeoutMs);

    try {
      const init: RequestInit = {
        body: JSON.stringify({
          messages: input.messages.map((message) => toProviderMessage(message)),
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
      const toolParts = new Map<number, { arguments: string; id: string; name: string }>();
      let lastUsage: ProviderUsage | undefined;
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length === 0 || !trimmed.startsWith("data:")) {
            continue;
          }
          const dataStr = trimmed.slice("data:".length).trim();
          if (dataStr === "[DONE]") {
            continue;
          }
          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(dataStr) as Record<string, unknown>;
          } catch {
            continue;
          }
          const usageRaw = chunk["usage"] as
            | {
                completion_tokens?: number;
                prompt_tokens?: number;
                total_tokens?: number;
              }
            | undefined;
          if (usageRaw !== undefined) {
            lastUsage = toUsage(usageRaw);
          }

          const choices = chunk["choices"] as Array<{ delta?: Record<string, unknown> }> | undefined;
          const choice = choices?.[0];
          const delta = choice?.delta as
            | {
                content?: string;
                tool_calls?: Array<{
                  function?: { arguments?: string; name?: string };
                  id?: string;
                  index?: number;
                }>;
              }
            | undefined;
          if (delta === undefined) {
            continue;
          }

          if (typeof delta.content === "string" && delta.content.length > 0) {
            fullContent += delta.content;
            input.onTextDelta?.(delta.content);
          }

          if (Array.isArray(delta.tool_calls)) {
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
        }
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

      if (toolCalls.length > 0) {
        return {
          kind: "tool_calls",
          message: content.length > 0 ? content : "Provider requested tool execution.",
          metadata,
          toolCalls,
          usage
        };
      }

      return {
        kind: "final",
        message: content,
        metadata,
        usage
      };
    } catch (error) {
      throw toProviderError(error, this.name, this.model);
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
        message: `Missing API key for ${this.describe().displayName}.`,
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
}

function toProviderMessage(message: ConversationMessage): OpenAiCompatibleMessage {
  if (message.role === "assistant" && message.toolCalls !== undefined && message.toolCalls.length > 0) {
    return {
      content: message.content.length > 0 ? message.content : null,
      role: "assistant",
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
      content: message.content,
      role: "tool",
      ...(message.toolCallId !== undefined ? { tool_call_id: message.toolCallId } : {})
    };
  }

  return {
    content: message.content,
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

function toUsage(
  rawUsage:
    | {
        completion_tokens?: number;
        prompt_tokens?: number;
        total_tokens?: number;
      }
    | undefined
): ProviderUsage {
  const usage: ProviderUsage = {
    inputTokens: rawUsage?.prompt_tokens ?? 0,
    outputTokens: rawUsage?.completion_tokens ?? 0
  };

  if (rawUsage?.total_tokens !== undefined) {
    usage.totalTokens = rawUsage.total_tokens;
  }

  return usage;
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

function ensureTrailingSlash(value: string | null): string {
  if (value === null) {
    return "";
  }

  return value.endsWith("/") ? value : `${value}/`;
}

function isNonEmptyString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function composeAbortSignal(
  parent: AbortSignal | undefined,
  timeoutSignal: AbortSignal
): AbortSignal {
  if (parent === undefined) {
    return timeoutSignal;
  }

  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([parent, timeoutSignal]);
  }

  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  parent.addEventListener("abort", abort, { once: true });
  timeoutSignal.addEventListener("abort", abort, { once: true });
  return controller.signal;
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
