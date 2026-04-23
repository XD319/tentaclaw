import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentProfileId } from "../../types/index.js";

export interface McpServerRuntimeConfig {
  exposeSkills: boolean;
  exposeTools: string[];
  externalIdentity: {
    runtimeUserId: string;
    agentProfileId: AgentProfileId;
  };
}

export function resolveMcpServerConfig(workspaceRoot: string): McpServerRuntimeConfig {
  const path = join(workspaceRoot, ".auto-talon", "mcp-server.config.json");
  if (!existsSync(path)) {
    return defaultConfig();
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<McpServerRuntimeConfig>;
  return {
    exposeSkills: parsed.exposeSkills ?? true,
    exposeTools: Array.isArray(parsed.exposeTools) ? parsed.exposeTools : ["file_read", "skill_view", "web_fetch"],
    externalIdentity: {
      agentProfileId:
        parsed.externalIdentity?.agentProfileId === "executor" ||
        parsed.externalIdentity?.agentProfileId === "planner" ||
        parsed.externalIdentity?.agentProfileId === "reviewer"
          ? parsed.externalIdentity.agentProfileId
          : "reviewer",
      runtimeUserId: parsed.externalIdentity?.runtimeUserId ?? "mcp_external"
    }
  };
}

function defaultConfig(): McpServerRuntimeConfig {
  return {
    exposeSkills: true,
    exposeTools: ["file_read", "skill_view", "web_fetch"],
    externalIdentity: {
      agentProfileId: "reviewer",
      runtimeUserId: "mcp_external"
    }
  };
}
