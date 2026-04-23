import type { ZodTypeAny } from "zod";

import type { JsonObject, JsonValue } from "./common.js";
import type { RuntimeErrorCode } from "./error.js";
import type { ToolCapability, ToolRiskLevel, PrivacyLevel, PathScope } from "./governance.js";
import type { SandboxExecutionPlan } from "./sandbox.js";
import type { AgentProfileId } from "./profile.js";

export const TOOL_CALL_STATUSES = [
  "requested",
  "awaiting_approval",
  "approved",
  "started",
  "denied",
  "timed_out",
  "finished",
  "failed"
] as const;

export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];

export const TOOL_CALL_STATUS_TRANSITIONS: Record<ToolCallStatus, ToolCallStatus[]> = {
  approved: ["started", "denied", "timed_out"],
  awaiting_approval: ["approved", "denied", "timed_out"],
  denied: [],
  failed: [],
  finished: [],
  requested: ["awaiting_approval", "started", "failed"],
  started: ["finished", "failed"],
  timed_out: []
};

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
  userId: string;
  agentProfileId: AgentProfileId;
  signal: AbortSignal;
}

export interface ToolGovernanceDescriptor {
  summary: string;
  pathScope: PathScope;
}

export interface ToolPreparation<TPreparedInput = unknown> {
  preparedInput: TPreparedInput;
  governance: ToolGovernanceDescriptor;
  sandbox: SandboxExecutionPlan;
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

export interface ToolDefinition<
  TSchema extends ZodTypeAny = ZodTypeAny,
  TPreparedInput = unknown
> {
  name: string;
  description: string;
  capability: ToolCapability;
  riskLevel: ToolRiskLevel;
  privacyLevel: PrivacyLevel;
  inputSchema: TSchema;
  inputSchemaDescriptor: ToolSchemaDescriptor;
  prepare(
    input: unknown,
    context: ToolExecutionContext
  ): Promise<ToolPreparation<TPreparedInput>> | ToolPreparation<TPreparedInput>;
  execute(
    preparedInput: TPreparedInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult>;
}

export function canTransitionToolCallStatus(
  currentStatus: ToolCallStatus,
  nextStatus: ToolCallStatus
): boolean {
  return TOOL_CALL_STATUS_TRANSITIONS[currentStatus].includes(nextStatus);
}
