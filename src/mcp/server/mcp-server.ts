import type { McpServerRuntimeConfig } from "./mcp-server-config.js";
import type { McpSkillBridge } from "./mcp-skill-bridge.js";
import type { McpToolBridge } from "./mcp-tool-bridge.js";
import type { JsonObject } from "../../types/index.js";

export interface McpJsonRpcRequest {
  id?: number | undefined;
  jsonrpc?: string;
  method?: string;
  params?: JsonObject;
}

export interface McpJsonRpcResponse {
  id?: number | undefined;
  jsonrpc: "2.0";
  result?: JsonObject;
  error?: {
    code: number;
    message: string;
  };
}

export class McpServer {
  public constructor(
    private readonly config: McpServerRuntimeConfig,
    private readonly toolBridge: McpToolBridge,
    private readonly skillBridge: McpSkillBridge
  ) {}

  public async handle(request: McpJsonRpcRequest): Promise<McpJsonRpcResponse> {
    if (request.method === "initialize") {
      return {
        id: request.id,
        jsonrpc: "2.0",
        result: {
          capabilities: {
            resources: this.config.exposeSkills,
            tools: true
          },
          serverInfo: {
            name: "auto-talon-mcp",
            version: "phase5"
          }
        }
      };
    }

    if (request.method === "tools/list") {
      return {
        id: request.id,
        jsonrpc: "2.0",
        result: {
          tools: this.toolBridge.listTools(this.config.exposeTools)
        }
      };
    }

    if (request.method === "tools/call") {
      const name = typeof request.params?.name === "string" ? request.params.name : "";
      const args = isJsonObject(request.params?.arguments) ? request.params.arguments : {};
      let outcome;
      try {
        outcome = await this.toolBridge.callTool({
          arguments: args,
          name
        });
      } catch (error) {
        return this.error(
          request.id,
          -32001,
          error instanceof Error ? error.message : `Tool call failed: ${String(error)}`
        );
      }
      return {
        id: request.id,
        jsonrpc: "2.0",
        result: {
          content: outcome.content,
          status: outcome.status
        }
      };
    }

    if (request.method === "resources/list") {
      return {
        id: request.id,
        jsonrpc: "2.0",
        result: {
          resources: this.config.exposeSkills ? this.skillBridge.listResources() : []
        }
      };
    }

    if (request.method === "resources/read") {
      const uri = typeof request.params?.uri === "string" ? request.params.uri : "";
      const resource = this.config.exposeSkills ? this.skillBridge.readResource(uri) : null;
      if (resource === null) {
        return this.error(request.id, -32004, `Resource not found: ${uri}`);
      }
      return {
        id: request.id,
        jsonrpc: "2.0",
        result: {
          contents: [resource]
        }
      };
    }

    return this.error(request.id, -32601, `Method not found: ${request.method ?? "unknown"}`);
  }

  private error(id: number | undefined, code: number, message: string): McpJsonRpcResponse {
    return {
      error: {
        code,
        message
      },
      id,
      jsonrpc: "2.0"
    };
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
