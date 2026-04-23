import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { McpClientManager } from "../src/mcp/index.js";

describe("McpClientManager", () => {
  it("discovers configured mcp tools with runtime-safe naming", () => {
    const workspace = mkdtempSync(join(tmpdir(), "auto-talon-mcp-"));
    try {
      mkdirSync(join(workspace, ".auto-talon"), { recursive: true });
      const serverScript = resolve(process.cwd(), "test", "fixtures", "mcp-fake-server.js");
      writeFileSync(
        join(workspace, ".auto-talon", "mcp.config.json"),
        `${JSON.stringify(
          {
            servers: [
              {
                args: [serverScript],
                command: process.execPath,
                env: {},
                id: "fake",
                privacyLevel: "internal",
                riskLevel: "high"
              }
            ]
          },
          null,
          2
        )}\n`,
        "utf8"
      );

      const manager = new McpClientManager(workspace);
      const tools = manager.discover();
      expect(tools.some((tool) => tool.name === "mcp__fake__echo")).toBe(true);
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });
});
