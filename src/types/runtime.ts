import type { JsonObject, TokenBudget } from "./common.js";
import type { ToolCapability, PrivacyLevel } from "./governance.js";
import type { ContextFragment } from "./memory.js";
import type { AgentProfileId } from "./profile.js";
import type { TaskRecord } from "./task.js";
import type { ToolSchemaDescriptor } from "./tool.js";

export type ConversationRole = "assistant" | "system" | "tool" | "user";

export interface ConversationMessage {
  role: ConversationRole;
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ProviderToolCall[];
  metadata?: JsonObject;
}

export interface ProviderToolDescriptor {
  name: string;
  description: string;
  riskLevel: "low" | "medium" | "high";
  capability: ToolCapability;
  privacyLevel: PrivacyLevel;
  inputSchema: ToolSchemaDescriptor;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cachedInputTokens?: number;
}

export interface ProviderToolCall {
  toolCallId: string;
  toolName: string;
  input: JsonObject;
  reason: string;
  raw?: JsonObject;
}

export interface ProviderRequest {
  task: TaskRecord;
  iteration: number;
  messages: ConversationMessage[];
  availableTools: ProviderToolDescriptor[];
  agentProfileId: AgentProfileId;
  memoryContext: ContextFragment[];
  tokenBudget: TokenBudget;
  signal: AbortSignal;
  /** When set, OpenAI-compatible providers may stream assistant text deltas before the final response. */
  onTextDelta?: (delta: string) => void;
}

export type ProviderInput = ProviderRequest;

export interface ProviderResponseMetadata {
  providerName?: string;
  modelName?: string;
  finishReason?: string | null;
  requestId?: string | null;
  retryCount?: number;
  raw?: JsonObject;
}

export interface ProviderResponseBase {
  usage: ProviderUsage;
  metadata?: ProviderResponseMetadata;
}

export interface ProviderFinalResponse extends ProviderResponseBase {
  kind: "final";
  message: string;
}

export interface ProviderRetryResponse extends ProviderResponseBase {
  kind: "retry";
  message: string;
  reason: string;
  delayMs: number;
}

export interface ProviderToolCallResponse extends ProviderResponseBase {
  kind: "tool_calls";
  message: string;
  toolCalls: ProviderToolCall[];
}

export type ProviderResponse =
  | ProviderFinalResponse
  | ProviderRetryResponse
  | ProviderToolCallResponse;

export type ProviderErrorCategory =
  | "auth_error"
  | "invalid_request"
  | "malformed_response"
  | "rate_limit"
  | "timeout_error"
  | "transient_network_error"
  | "provider_unavailable"
  | "unsupported_capability"
  | "unknown_error";

export interface ProviderErrorShape {
  category: ProviderErrorCategory;
  message: string;
  providerName: string;
  modelName?: string | undefined;
  statusCode?: number | undefined;
  retriable?: boolean | undefined;
  retryCount?: number | undefined;
  summary?: string | undefined;
  details?: JsonObject | undefined;
  cause?: unknown;
}

export interface ProviderCapabilities {
  streaming: boolean;
  textGeneration: boolean;
  toolCalls: boolean;
}

export interface ProviderDescriptor {
  baseUrl: string | null;
  capabilities: ProviderCapabilities;
  displayName: string;
  model: string | null;
  name: string;
}

export interface ProviderStreamEvent {
  done?: boolean;
  textDelta?: string;
  toolCall?: ProviderToolCall;
  usage?: ProviderUsage;
}

export interface ProviderHealthCheck {
  apiKeyConfigured: boolean;
  endpointReachable: boolean | null;
  errorCategory?: ProviderErrorCategory;
  latencyMs?: number;
  message: string;
  modelAvailable: boolean | null;
  modelConfigured: boolean;
  modelName: string | null;
  ok: boolean;
  providerName: string;
}

export interface ProviderConfig {
  apiKey: string | null;
  baseUrl: string | null;
  maxRetries: number;
  model: string | null;
  name: string;
  timeoutMs: number;
}

export interface ProviderRetryPolicy {
  backoffMs: number;
  maxRetries: number;
}

export interface ProviderStatsSnapshot {
  averageLatencyMs: number;
  failedRequests: number;
  lastErrorCategory: ProviderErrorCategory | null;
  lastRequestAt: string | null;
  providerName: string;
  retryCount: number;
  successfulRequests: number;
  tokenUsage: ProviderUsage;
  totalRequests: number;
}

export interface Provider {
  name: string;
  model?: string | undefined;
  capabilities?: ProviderCapabilities | undefined;
  describe?: (() => ProviderDescriptor) | undefined;
  generate(input: ProviderRequest): Promise<ProviderResponse>;
  getStats?: (() => ProviderStatsSnapshot) | undefined;
  streamGenerate?: ((input: ProviderRequest) => AsyncIterable<ProviderStreamEvent>) | undefined;
  testConnection?: ((signal?: AbortSignal) => Promise<ProviderHealthCheck>) | undefined;
}

export interface RuntimeRunOptions {
  taskInput: string;
  cwd: string;
  userId: string;
  agentProfileId: AgentProfileId;
  maxIterations: number;
  taskId?: string;
  timeoutMs: number;
  tokenBudget: TokenBudget;
  signal?: AbortSignal;
  metadata?: JsonObject;
  /** Forwarded to the provider as `onTextDelta` when supported (e.g. OpenAI-compatible streaming). */
  onAssistantTextDelta?: (delta: string) => void;
  /** Unified task stream callback for lifecycle, stage, tool, and result events. */
  onTaskEvent?: (event: RuntimeTaskEvent) => void;
}

export interface RuntimeRunResult {
  task: TaskRecord;
  output: string | null;
}

export type RuntimeTaskEvent =
  | {
      kind: "lifecycle";
      taskId: string;
      status: string;
      iteration: number;
      message: string;
    }
  | {
      kind: "stage";
      taskId: string;
      stage: "planning" | "tooling" | "completion";
      iteration: number;
      message: string;
    }
  | {
      kind: "tool";
      taskId: string;
      toolCallId: string;
      toolName: string;
      status: "started" | "approval_required" | "finished" | "failed";
      iteration: number;
      summary?: string;
    }
  | {
      kind: "result";
      taskId: string;
      status: "succeeded" | "failed" | "cancelled";
      outputPreview: string | null;
      errorCode?: string | null;
      errorMessage?: string | null;
    };
