import {
  isStableMemoryPrefixMessage,
  isStableSystemPromptMessage
} from "../core/prompt-prefix.js";
import type {
  ConversationMessage,
  JsonObject,
  ProviderRequest,
  ProviderToolDescriptor
} from "../types/index.js";

export const ANTHROPIC_PROMPT_CACHING_BETA = "prompt-caching-2024-07-31";
export const ANTHROPIC_CACHE_CONTROL_EPHEMERAL = { type: "ephemeral" } as const;

type AnthropicCacheControl = { type: "ephemeral" };

export type AnthropicSystemBlock = {
  cache_control?: AnthropicCacheControl;
  text: string;
  type: "text";
};

type AnthropicContentBlock =
  | {
      cache_control?: AnthropicCacheControl;
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

export interface AnthropicCompatibleMessage extends JsonObject {
  content: string | AnthropicContentBlock[];
  role: "assistant" | "user";
}

export interface AnthropicCompatibleRequestBody extends JsonObject {
  max_tokens: number;
  messages: AnthropicCompatibleMessage[];
  model: string;
  stream?: boolean;
  system?: string | AnthropicSystemBlock[];
  tools?: JsonObject[];
}

export function buildAnthropicCompatibleRequestBody(
  input: ProviderRequest,
  model: string,
  extras: { stream?: boolean } = {}
): AnthropicCompatibleRequestBody {
  const tools = toAnthropicTools(input.availableTools);
  const system = toAnthropicSystemBlocks(input.messages);
  const body: AnthropicCompatibleRequestBody = {
    max_tokens: Math.max(1, input.tokenBudget.outputLimit),
    messages: toAnthropicMessages(input.messages),
    model
  };
  if (system !== undefined) {
    body.system = system;
  }
  if (tools.length > 0) {
    body.tools = tools;
  }
  if (extras.stream === true) {
    body.stream = true;
  }
  return body;
}

export function anthropicRequestUsesPromptCache(body: JsonObject | undefined): boolean {
  if (body === undefined) {
    return false;
  }
  if (Array.isArray(body.system) && body.system.some((block) => hasCacheControl(block))) {
    return true;
  }
  return Array.isArray(body.tools) && body.tools.some((tool) => hasCacheControl(tool));
}

function hasCacheControl(value: unknown): boolean {
  return typeof value === "object" && value !== null && "cache_control" in value;
}

export function toAnthropicSystemBlocks(
  messages: ConversationMessage[]
): AnthropicSystemBlock[] | undefined {
  const systemMessages = messages.filter((message) => message.role === "system");
  const stableSystem = joinSystemTexts(systemMessages.filter(isStableSystemPromptMessage));
  const stableMemory = joinSystemTexts(systemMessages.filter(isStableMemoryPrefixMessage));
  const variable = joinSystemTexts(
    systemMessages.filter(
      (message) => !isStableSystemPromptMessage(message) && !isStableMemoryPrefixMessage(message)
    )
  );

  const blocks: AnthropicSystemBlock[] = [];
  if (stableSystem !== null) {
    blocks.push(textBlock(stableSystem, true));
  }
  if (stableMemory !== null) {
    blocks.push(textBlock(stableMemory, true));
  }
  if (variable !== null) {
    blocks.push(textBlock(variable, false));
  }

  return blocks.length > 0 ? blocks : undefined;
}

export function toAnthropicMessages(messages: ConversationMessage[]): AnthropicCompatibleMessage[] {
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
        const contentBlocks: AnthropicContentBlock[] = [];
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

export function toAnthropicTools(tools: ProviderToolDescriptor[]): JsonObject[] {
  return tools.map((tool, index) => {
    const encoded: JsonObject = {
      description: tool.description,
      input_schema: tool.inputSchema,
      name: tool.name
    };
    if (index === tools.length - 1) {
      encoded.cache_control = ANTHROPIC_CACHE_CONTROL_EPHEMERAL;
    }
    return encoded;
  });
}

function joinSystemTexts(messages: ConversationMessage[]): string | null {
  const text = messages
    .map((message) => message.content.trim())
    .filter((message) => message.length > 0)
    .join("\n\n");
  return text.length > 0 ? text : null;
}

function textBlock(text: string, cacheable: boolean): AnthropicSystemBlock {
  if (cacheable) {
    return {
      cache_control: ANTHROPIC_CACHE_CONTROL_EPHEMERAL,
      text,
      type: "text"
    };
  }
  return {
    text,
    type: "text"
  };
}
