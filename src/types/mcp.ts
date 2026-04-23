import type { JsonObject, JsonValue } from "./common.js";
import type { PrivacyLevel, ToolRiskLevel } from "./governance.js";

export interface McpServerConfig {
  id: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  riskLevel: ToolRiskLevel;
  privacyLevel: PrivacyLevel;
}

export interface McpConfigFile {
  servers: McpServerConfig[];
}

export interface McpToolDescriptor {
  serverId: string;
  name: string;
  description: string;
  inputSchema: JsonObject;
}

export interface McpInvocationContext {
  signal?: AbortSignal;
}

export interface McpToolCallRequest {
  toolName: string;
  input: JsonObject;
}

export interface McpToolCallResult {
  content: JsonValue;
}

export interface McpClientHandle {
  serverId: string;
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(
    request: McpToolCallRequest,
    context?: McpInvocationContext
  ): Promise<McpToolCallResult>;
  ping(): Promise<void>;
  close(): Promise<void>;
}
