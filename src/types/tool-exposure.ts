import type { JsonObject } from "./common.js";
import type { ProviderToolDescriptor } from "./runtime.js";

export type ToolCostLevel = "free" | "cheap" | "moderate" | "expensive";
export type ToolSideEffectLevel =
  | "none"
  | "read_only"
  | "external_read_only"
  | "workspace_mutation"
  | "external_mutation";
export type ToolApprovalDefault = "never" | "when_needed" | "always";
export type ToolKind = "runtime_primitive" | "external_tool" | "control_command";

export interface ToolAvailabilityResult extends JsonObject {
  available: boolean;
  reason: string;
}

export interface ToolExposureDecision extends JsonObject {
  toolName: string;
  exposed: boolean;
  reason: string;
  costWarning?: boolean;
}

export interface ToolExposurePlan {
  tools: ProviderToolDescriptor[];
  decisions: ToolExposureDecision[];
  plannerReasons: string[];
}
