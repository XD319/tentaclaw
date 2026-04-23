import { z } from "zod";

import type {
  JsonObject,
  McpClientHandle,
  McpServerConfig,
  McpToolDescriptor,
  SandboxMcpPlan,
  ToolDefinition,
  ToolExecutionResult,
  ToolPreparation
} from "../../types/index.js";

interface PreparedMcpToolInput {
  input: JsonObject;
  plan: SandboxMcpPlan;
  toolName: string;
}

const mcpToolInputSchema = z.record(z.string(), z.json());

export class McpToolAdapter implements ToolDefinition<typeof mcpToolInputSchema, PreparedMcpToolInput> {
  public readonly name: string;
  public readonly description: string;
  public readonly capability = "mcp.invoke" as const;
  public readonly riskLevel: McpServerConfig["riskLevel"];
  public readonly privacyLevel: McpServerConfig["privacyLevel"];
  public readonly inputSchema = mcpToolInputSchema;
  public readonly inputSchemaDescriptor: {
    properties: JsonObject;
    required: string[];
    type: string;
  };

  public constructor(
    private readonly tool: McpToolDescriptor,
    private readonly config: McpServerConfig,
    private readonly handle: McpClientHandle
  ) {
    this.name = `mcp__${tool.serverId}__${tool.name}`;
    this.description = tool.description || `Invoke MCP tool ${tool.serverId}/${tool.name}`;
    this.riskLevel = config.riskLevel;
    this.privacyLevel = config.privacyLevel;
    this.inputSchemaDescriptor = {
      properties: toJsonObject(
        typeof tool.inputSchema.properties === "object" && tool.inputSchema.properties !== null
          ? tool.inputSchema.properties
          : {}
      ),
      required: Array.isArray(tool.inputSchema.required)
        ? tool.inputSchema.required.filter((entry): entry is string => typeof entry === "string")
        : [],
      type: "object"
    };
  }

  public prepare(input: unknown): ToolPreparation<PreparedMcpToolInput> {
    const parsed = this.inputSchema.parse(input);
    const plan: SandboxMcpPlan = {
      kind: "mcp",
      pathScope: "network",
      serverId: this.tool.serverId,
      target: `${this.tool.serverId}/${this.tool.name}`,
      toolName: this.tool.name
    };
    return {
      governance: {
        pathScope: "network",
        summary: `Invoke MCP tool ${this.tool.serverId}/${this.tool.name}`
      },
      preparedInput: {
        input: parsed,
        plan,
        toolName: this.tool.name
      },
      sandbox: plan
    };
  }

  public async execute(input: PreparedMcpToolInput): Promise<ToolExecutionResult> {
    try {
      const result = await this.handle.callTool({
        input: input.input,
        toolName: input.toolName
      });
      return {
        output: {
          content: result.content,
          serverId: this.tool.serverId,
          toolName: this.tool.name
        },
        success: true,
        summary: `MCP ${this.tool.serverId}/${this.tool.name} executed`
      };
    } catch (error) {
      return {
        details: {
          error: error instanceof Error ? error.message : String(error),
          serverId: this.tool.serverId,
          toolName: this.tool.name
        },
        errorCode: "tool_execution_error",
        errorMessage: `MCP ${this.tool.serverId}/${this.tool.name} execution failed`,
        success: false
      };
    }
  }
}

function toJsonObject(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as JsonObject;
}
