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
} from "../types/index.js";

import type { ProviderError } from "./provider-error.js";
import {
  classifyProviderHttpError,
  createProviderError,
  isRetriableCategory,
  toProviderError
} from "./provider-runtime.js";

type AnthropicCompatibleContentBlock =
  | {
      text: string;
      type: "text";
    }
  | {
      content: string;
      tool_use_id: string;
      type: "tool_result";
    }
  | {
      id: string;
      input: JsonObject;
      name: string;
      type: "tool_use";
    };

interface AnthropicCompatibleMessage extends JsonObject {
  content:
    | string
    | AnthropicCompatibleContentBlock[];
  role: "assistant" | "user";
}

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
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
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

export class AnthropicCompatibleProvider implements Provider {
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
      displayName: this.options.providerLabel ?? this.options.defaultDisplayName,
      model: this.model,
      name: this.name
    };
  }

  public async generate(input: ProviderRequest): Promise<ProviderResponse> {
    this.ensureConfigured();

    const response = await this.requestJson<AnthropicCompatibleResponse>(
      "v1/messages",
      {
        max_tokens: Math.max(1, input.tokenBudget.outputLimit),
        messages: toAnthropicMessages(input.messages),
        model: this.model,
        system: readSystemPrompt(input.messages),
        tools: input.availableTools.map((tool) => toAnthropicTool(tool))
      },
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
      const headers: Record<string, string> = {
        "anthropic-version": this.options.anthropicVersion ?? "2023-06-01",
        "Content-Type": "application/json"
      };
      if (this.config.apiKey !== null) {
        headers["x-api-key"] = this.config.apiKey;
      }

      const init: RequestInit = {
        headers,
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
}

function toAnthropicMessages(messages: ConversationMessage[]): AnthropicCompatibleMessage[] {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      const content = typeof message.content === "string" ? message.content : "";
      if (message.role === "tool") {
        return {
          content: [
            {
              content,
              tool_use_id: message.toolCallId ?? "tool-result",
              type: "tool_result"
            }
          ],
          role: "user"
        } satisfies AnthropicCompatibleMessage;
      }

      if (message.role === "assistant" && message.toolCalls !== undefined && message.toolCalls.length > 0) {
        const contentBlocks: AnthropicCompatibleContentBlock[] = [];
        if (content.trim().length > 0) {
          contentBlocks.push({
            text: content,
            type: "text"
          });
        }

        for (const toolCall of message.toolCalls) {
          contentBlocks.push({
            id: toolCall.toolCallId,
            input: toolCall.input,
            name: toolCall.toolName,
            type: "tool_use"
          });
        }

        return {
          content: contentBlocks,
          role: "assistant"
        };
      }

      return {
        content,
        role: message.role === "assistant" ? "assistant" : "user"
      };
    });
}

function readSystemPrompt(messages: ConversationMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter((message) => message.length > 0)
    .join("\n\n");
}

function toAnthropicTool(tool: ProviderToolDescriptor): JsonObject {
  return {
    description: tool.description,
    input_schema: tool.inputSchema,
    name: tool.name
  };
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

function toUsage(
  usage:
    | {
        input_tokens?: number;
        output_tokens?: number;
      }
    | undefined
): ProviderUsage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    totalTokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0)
  };
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

function ensureTrailingSlash(value: string | null): string {
  if (value === null) {
    return "";
  }

  return value.endsWith("/") ? value : `${value}/`;
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

function isNonEmptyString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
