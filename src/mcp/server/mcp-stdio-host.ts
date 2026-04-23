import { createInterface } from "node:readline";

import type { McpServer } from "./mcp-server.js";
import type { JsonObject } from "../../types/index.js";

export class McpStdioHost {
  public constructor(private readonly server: McpServer) {}

  public async start(): Promise<void> {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false
    });

    for await (const line of rl) {
      const text = line.trim();
      if (text.length === 0) {
        continue;
      }
      let request: {
        id?: number;
        jsonrpc?: string;
        method?: string;
        params?: JsonObject;
      };
      try {
        request = JSON.parse(text) as typeof request;
      } catch {
        process.stdout.write(
          `${JSON.stringify({
            error: { code: -32700, message: "Parse error" },
            jsonrpc: "2.0"
          })}\n`
        );
        continue;
      }

      const response = await this.server.handle(request);
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  }
}
