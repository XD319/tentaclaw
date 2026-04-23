import type {
  ConversationMessage,
  ProviderConfig,
  ProviderDescriptor,
  ProviderHealthCheck,
  Provider,
  ProviderRequest,
  ProviderResponse
} from "../types/index.js";

export class MockProvider implements Provider {
  public readonly capabilities = {
    streaming: false,
    textGeneration: true,
    toolCalls: true
  } as const;

  public readonly model: string;
  public readonly name = "mock";

  public constructor(
    config?: Partial<ProviderConfig>,
    private readonly responder?: (input: ProviderRequest) => Promise<ProviderResponse> | ProviderResponse
  ) {
    this.model = config?.model ?? "mock-default";
  }

  public describe(): ProviderDescriptor {
    return {
      baseUrl: null,
      capabilities: this.capabilities,
      displayName: "Mock Provider",
      model: this.model,
      name: this.name
    };
  }

  public testConnection(): Promise<ProviderHealthCheck> {
    return Promise.resolve({
      apiKeyConfigured: true,
      endpointReachable: true,
      message: "Mock provider is always available.",
      modelAvailable: true,
      modelConfigured: true,
      modelName: this.model,
      ok: true,
      providerName: this.name
    });
  }

  public generate(input: ProviderRequest): Promise<ProviderResponse> {
    if (this.responder !== undefined) {
      return Promise.resolve(this.responder(input));
    }

    const lastToolMessage = [...input.messages]
      .reverse()
      .find((message) => message.role === "tool");

    if (lastToolMessage !== undefined) {
      return Promise.resolve({
        kind: "final",
        message: `Task completed from tool feedback.\n${lastToolMessage.content}`,
        metadata: {
          modelName: this.model,
          providerName: this.name,
          retryCount: 0
        },
        usage: {
          inputTokens: estimateTokens(input.messages),
          outputTokens: estimateTokens(lastToolMessage.content)
        }
      });
    }

    const task = input.task.input.trim();
    const inferredToolCall = inferToolCall(task);
    if (inferredToolCall === null) {
      return Promise.resolve({
        kind: "final",
        message:
          "MockProvider did not infer any tool call. Provide tasks like `read <path>`, `list <path>`, `search <keyword> in <path>`, `write <path> :: <content>`, or `run shell: <command>`.",
        metadata: {
          modelName: this.model,
          providerName: this.name,
          retryCount: 0
        },
        usage: {
          inputTokens: estimateTokens(task),
          outputTokens: 24
        }
      });
    }

    return Promise.resolve({
      kind: "tool_calls",
      message: `Planning tool call ${inferredToolCall.toolName}`,
      metadata: {
        modelName: this.model,
        providerName: this.name,
        retryCount: 0
      },
      toolCalls: [inferredToolCall],
      usage: {
        inputTokens: estimateTokens(input.messages),
        outputTokens: 16
      }
    });
  }
}

function inferToolCall(task: string) {
  const normalizedTask = task.trim();

  const readMatch = normalizedTask.match(/^(?:read|show|cat)\s+(.+)$/iu);
  if (readMatch?.[1] !== undefined) {
    return {
      input: {
        action: "read_file",
        path: readMatch[1].trim()
      },
      reason: "The task explicitly asks to read a file.",
      toolCallId: "mock-read-1",
      toolName: "file_read"
    };
  }

  const listMatch = normalizedTask.match(/^(?:list|ls)\s+(.+)$/iu);
  if (listMatch?.[1] !== undefined) {
    return {
      input: {
        action: "list_dir",
        path: listMatch[1].trim()
      },
      reason: "The task explicitly asks to list a directory.",
      toolCallId: "mock-list-1",
      toolName: "file_read"
    };
  }

  const searchMatch = normalizedTask.match(/^search\s+(.+?)\s+in\s+(.+)$/iu);
  if (searchMatch?.[1] !== undefined && searchMatch[2] !== undefined) {
    return {
      input: {
        action: "search_text",
        keyword: searchMatch[1].trim(),
        path: searchMatch[2].trim()
      },
      reason: "The task explicitly asks to search text.",
      toolCallId: "mock-search-1",
      toolName: "file_read"
    };
  }

  const writeMatch = normalizedTask.match(/^write\s+(.+?)\s+::\s+([\s\S]+)$/iu);
  if (writeMatch?.[1] !== undefined && writeMatch[2] !== undefined) {
    return {
      input: {
        action: "write_file",
        content: writeMatch[2],
        overwrite: true,
        path: writeMatch[1].trim()
      },
      reason: "The task explicitly asks to write a file.",
      toolCallId: "mock-write-1",
      toolName: "file_write"
    };
  }

  const shellMatch = normalizedTask.match(/^(?:run\s+shell:|shell:)\s+([\s\S]+)$/iu);
  if (shellMatch?.[1] !== undefined) {
    return {
      input: {
        command: shellMatch[1].trim()
      },
      reason: "The task explicitly asks to run a shell command.",
      toolCallId: "mock-shell-1",
      toolName: "shell"
    };
  }

  return null;
}

function estimateTokens(messages: ConversationMessage[] | string): number {
  if (typeof messages === "string") {
    return Math.max(1, Math.ceil(messages.length / 4));
  }

  return messages.reduce((total, message) => total + estimateTokens(message.content), 0);
}
