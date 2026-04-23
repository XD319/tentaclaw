import { describe, expect, it } from "vitest";

import { McpServer } from "../src/mcp/index.js";

describe("McpServer protocol", () => {
  it("supports initialize and tool/resource listing", async () => {
    const server = new McpServer(
      {
        exposeSkills: true,
        exposeTools: ["file_read"],
        externalIdentity: {
          agentProfileId: "reviewer",
          runtimeUserId: "mcp_external"
        }
      },
      {
        listTools: () => [
          {
            description: "Read files",
            inputSchema: { type: "object" },
            name: "file_read"
          }
        ]
      } as never,
      {
        listResources: () => [
          {
            description: "Skill A",
            name: "skill-a",
            uri: "skill://skill-a"
          }
        ],
        readResource: () => null
      } as never
    );

    const init = await server.handle({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {}
    });
    expect(init.result?.serverInfo).toBeDefined();

    const tools = await server.handle({
      id: 2,
      jsonrpc: "2.0",
      method: "tools/list",
      params: {}
    });
    expect(Array.isArray(tools.result?.tools)).toBe(true);

    const resources = await server.handle({
      id: 3,
      jsonrpc: "2.0",
      method: "resources/list",
      params: {}
    });
    expect(Array.isArray(resources.result?.resources)).toBe(true);
  });
});
