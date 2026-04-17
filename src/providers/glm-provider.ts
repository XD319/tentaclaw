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

import { ProviderError } from "./provider-error";
import { classifyProviderHttpError, createProviderError, isRetriableCategory, toProviderError } from "./provider-runtime";

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

export class GlmProvider implements Provider {
  public readonly capabilities = {
    streaming: true,
    textGeneration: true,
    toolCalls: true
  } as const;

  public readonly model: string;
  public readonly name = "glm";

  public constructor(private readonly config: ProviderConfig) {
    this.model = config.model ?? "glm-4.5-air";
  }

  public describe(): ProviderDescriptor {
    return {
      baseUrl: this.config.baseUrl,
      capabilities: this.capabilities,
      displayName: "GLM",
      model: this.model,
      name: this.name
    };
  }

  public async generate(input: ProviderRequest): Promise<ProviderResponse> {
    this.ensureConfigured();

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
        message: response.error.message ?? "GLM returned an unknown error.",
        modelName: this.model,
        providerName: this.name,
        retriable: isRetriableCategory(category),
        summary: summarizeProviderCategory(category)
      });
    }

    const choice = response.choices?.[0];
    const message = choice?.message;
    const toolCalls = (message?.tool_calls ?? [])
      .map((toolCall, index) => parseToolCall(toolCall, index))
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

  public async testConnection(signal?: AbortSignal): Promise<ProviderHealthCheck> {
    const apiKeyConfigured = this.config.apiKey !== null && this.config.apiKey.length > 0;
    const modelConfigured = this.model.length > 0;

    if (!apiKeyConfigured) {
      return {
        apiKeyConfigured,
        endpointReachable: null,
        message: "Missing API key for GLM provider.",
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
            ? `Connected to GLM, but model ${this.model} was not listed by /models.`
            : "GLM endpoint reachable and authentication succeeded.",
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

  private ensureConfigured(): void {
    if (this.config.apiKey === null || this.config.apiKey.length === 0) {
      throw createProviderError({
        category: "auth_error",
        message: "GLM API key is not configured.",
        modelName: this.model,
        providerName: this.name,
        retriable: false,
        summary: "Authentication is not configured for the GLM provider."
      });
    }

    if (this.config.baseUrl === null || this.config.baseUrl.length === 0) {
      throw createProviderError({
        category: "invalid_request",
        message: "GLM base URL is not configured.",
        modelName: this.model,
        providerName: this.name,
        retriable: false,
        summary: "The GLM provider configuration is incomplete."
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
        new URL(path, ensureTrailingSlash(this.config.baseUrl)).toString(),
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
          message: extractErrorMessage(parsed) ?? `GLM request failed with status ${response.status}.`,
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
  index: number
): ProviderToolCall | null {
  const id = toolCall.id;
  const name = toolCall.function?.name;
  const rawArguments = toolCall.function?.arguments;
  if (!isNonEmptyString(id) || !isNonEmptyString(name) || !isNonEmptyString(rawArguments)) {
    return null;
  }

  return {
    input: parseToolArguments(rawArguments),
    raw: {
      arguments: rawArguments,
      index
    },
    reason: `Provider ${name} tool call requested.`,
    toolCallId: id,
    toolName: name
  };
}

function parseToolArguments(rawArguments: string): JsonObject {
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
      providerName: "glm",
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
