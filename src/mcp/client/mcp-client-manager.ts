import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { McpStdioTransport } from "./mcp-stdio-transport.js";
import { McpToolAdapter } from "./mcp-tool-adapter.js";
import type { McpConfigFile, McpServerConfig, ToolDefinition } from "../../types/index.js";

export class McpClientManager {
  private readonly configPath: string;
  private readonly handles = new Map<string, McpStdioTransport>();
  private readonly serverConfigs = new Map<string, McpServerConfig>();

  public constructor(workspaceRoot: string) {
    this.configPath = join(workspaceRoot, ".auto-talon", "mcp.config.json");
  }

  public discover(): ToolDefinition[] {
    const config = this.readConfig();
    const tools: ToolDefinition[] = [];
    for (const server of config.servers) {
      const handle = new McpStdioTransport(server);
      this.handles.set(server.id, handle);
      this.serverConfigs.set(server.id, server);
      try {
        const descriptors = handle.listToolsSync();
        for (const descriptor of descriptors) {
          tools.push(new McpToolAdapter(descriptor, server, handle));
        }
      } catch {
        continue;
      }
    }
    return tools;
  }

  public listServers(): Promise<
    Array<{ id: string; toolCount: number; tools: string[] }>
  > {
    const result: Array<{ id: string; toolCount: number; tools: string[] }> = [];
    for (const [serverId, handle] of this.handles) {
      let tools: Array<{ name: string }> = [];
      try {
        tools = handle.listToolsSync();
      } catch {
        tools = [];
      }
      result.push({
        id: serverId,
        toolCount: tools.length,
        tools: tools.map((tool) => tool.name)
      });
    }
    return Promise.resolve(result);
  }

  public ping(serverId: string): Promise<void> {
    const handle = this.handles.get(serverId);
    if (handle === undefined) {
      throw new Error(`MCP server ${serverId} is not configured.`);
    }
    handle.pingSync();
    return Promise.resolve();
  }

  public async close(): Promise<void> {
    for (const handle of this.handles.values()) {
      await handle.close();
    }
    this.handles.clear();
    this.serverConfigs.clear();
  }

  private readConfig(): McpConfigFile {
    if (!existsSync(this.configPath)) {
      return { servers: [] };
    }
    const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as Partial<McpConfigFile>;
    if (!Array.isArray(parsed.servers)) {
      return { servers: [] };
    }
    return {
      servers: parsed.servers
        .filter((server): server is McpServerConfig => {
          return (
            typeof server?.id === "string" &&
            typeof server?.command === "string" &&
            Array.isArray(server?.args)
          );
        })
        .map((server) => ({
          args: server.args,
          command: server.command,
          env: server.env ?? {},
          id: server.id,
          privacyLevel: server.privacyLevel ?? "internal",
          riskLevel: server.riskLevel ?? "high"
        }))
    };
  }
}
