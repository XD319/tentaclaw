import type { ZodTypeAny } from "zod";

import type { JsonObject, JsonValue } from "./common";
import type { RuntimeErrorCode } from "./error";

export const TOOL_RISK_LEVELS = ["low", "medium", "high"] as const;

export type ToolRiskLevel = (typeof TOOL_RISK_LEVELS)[number];

export const TOOL_CALL_STATUSES = [
  "requested",
  "started",
  "finished",
  "failed"
] as const;

export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];

export interface ToolSchemaDescriptor extends JsonObject {
  type: string;
  properties?: JsonObject;
  required?: string[];
}

export interface ArtifactRecord {
  artifactId: string;
  taskId: string;
  toolCallId: string | null;
  artifactType: string;
  uri: string;
  content: JsonValue;
  createdAt: string;
}

export interface ArtifactDraft {
  artifactType: string;
  uri: string;
  content: JsonValue;
}

export interface ToolCallRecord {
  toolCallId: string;
  taskId: string;
  iteration: number;
  toolName: string;
  riskLevel: ToolRiskLevel;
  status: ToolCallStatus;
  input: JsonObject;
  output: JsonValue | null;
  summary: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: RuntimeErrorCode | null;
  errorMessage: string | null;
}

export interface ToolExecutionContext {
  taskId: string;
  iteration: number;
  workspaceRoot: string;
  cwd: string;
  signal: AbortSignal;
}

export interface ToolExecutionSuccess {
  success: true;
  summary: string;
  output: JsonValue;
  artifacts?: ArtifactDraft[];
}

export interface ToolExecutionFailure {
  success: false;
  errorCode: RuntimeErrorCode;
  errorMessage: string;
  details?: JsonObject;
}

export type ToolExecutionResult = ToolExecutionFailure | ToolExecutionSuccess;

export interface ToolCallRequest {
  taskId: string;
  iteration: number;
  toolCallId: string;
  toolName: string;
  input: JsonObject;
  reason: string;
}

export interface ToolDefinition<TSchema extends ZodTypeAny = ZodTypeAny> {
  name: string;
  description: string;
  riskLevel: ToolRiskLevel;
  inputSchema: TSchema;
  inputSchemaDescriptor: ToolSchemaDescriptor;
  execute(
    input: unknown,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult>;
}
