import { describe, expect, it } from "vitest";

import { McpToolBridge } from "../src/mcp/index.js";
import { createApplication } from "../src/runtime/index.js";

describe("McpToolBridge governance", () => {
  it("denies shell execution for default mcp_external identity", async () => {
    const handle = createApplication(process.cwd());
    try {
      const bridge = new McpToolBridge(handle.infrastructure.toolOrchestrator, process.cwd(), {
        agentProfileId: "reviewer",
        runtimeUserId: "mcp_external"
      });

      await expect(
        bridge.callTool({
          arguments: {
            command: "node -v"
          },
          name: "shell"
        })
      ).rejects.toThrow(/cannot|deny|denied|policy/iu);
    } finally {
      handle.close();
    }
  });
});
