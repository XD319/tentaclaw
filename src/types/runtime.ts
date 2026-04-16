import type { JsonObject, TokenBudget } from "./common";
import type { TaskRecord } from "./task";
import type { ToolSchemaDescriptor } from "./tool";

export type ConversationRole = "assistant" | "system" | "tool" | "user";

export interface ConversationMessage {
  role: ConversationRole;
  content: string;
  toolCallId?: string;
  toolName?: string;
}

export interface ProviderToolDescriptor {
  name: string;
  description: string;
  riskLevel: "low" | "medium" | "high";
  inputSchema: ToolSchemaDescriptor;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderToolCall {
  toolCallId: string;
  toolName: string;
  input: JsonObject;
  reason: string;
}

export interface ProviderInput {
  task: TaskRecord;
  iteration: number;
  messages: ConversationMessage[];
  availableTools: ProviderToolDescriptor[];
  memoryContext: string[];
  tokenBudget: TokenBudget;
  signal: AbortSignal;
}

export interface ProviderFinalResponse {
  kind: "final";
  message: string;
  usage: ProviderUsage;
}

export interface ProviderRetryResponse {
  kind: "retry";
  message: string;
  reason: string;
  delayMs: number;
  usage: ProviderUsage;
}

export interface ProviderToolCallResponse {
  kind: "tool_calls";
  message: string;
  toolCalls: ProviderToolCall[];
  usage: ProviderUsage;
}

export type ProviderResponse =
  | ProviderFinalResponse
  | ProviderRetryResponse
  | ProviderToolCallResponse;

export interface Provider {
  name: string;
  generate(input: ProviderInput): Promise<ProviderResponse>;
}

export interface RuntimeRunOptions {
  taskInput: string;
  cwd: string;
  maxIterations: number;
  timeoutMs: number;
  tokenBudget: TokenBudget;
  signal?: AbortSignal;
  metadata?: JsonObject;
}

export interface RuntimeRunResult {
  task: TaskRecord;
  output: string | null;
}
