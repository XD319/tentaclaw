import type { LocalPolicyConfig } from "../types/index.js";

export const DEFAULT_LOCAL_POLICY_CONFIG: LocalPolicyConfig = {
  defaultEffect: "deny",
  rules: [
    {
      description: "Never allow tools to escape the workspace boundary.",
      effect: "deny",
      id: "deny-outside-workspace",
      match: {
        pathScopes: ["outside_workspace", "outside_write_root"]
      },
      priority: 100
    },
    {
      description: "Reviewer profile is read-focused and cannot mutate files or run shell.",
      effect: "deny",
      id: "reviewer-read-only",
      match: {
        agentProfiles: ["reviewer"],
        capabilities: ["filesystem.write", "shell.execute", "mcp.invoke"]
      },
      priority: 90
    },
    {
      description: "External MCP identity cannot run shell or write files by default.",
      effect: "deny",
      id: "mcp-external-read-only",
      match: {
        capabilities: ["filesystem.write", "shell.execute"],
        users: ["mcp_external"]
      },
      priority: 89
    },
    {
      description: "MCP invocation is approval-gated for non-reviewer profiles.",
      effect: "allow_with_approval",
      id: "mcp-invoke-needs-approval",
      match: {
        capabilities: ["mcp.invoke"]
      },
      priority: 85
    },
    {
      description: "Shell execution is always approval-gated.",
      effect: "allow_with_approval",
      id: "shell-needs-approval",
      match: {
        capabilities: ["shell.execute"]
      },
      priority: 80
    },
    {
      description: "Workspace file writes are allowed by default.",
      effect: "allow",
      id: "workspace-file-write-allow",
      match: {
        capabilities: ["filesystem.write"],
        pathScopes: ["workspace"]
      },
      priority: 80
    },
    {
      description: "Extra write-root file writes are approval-gated.",
      effect: "allow_with_approval",
      id: "extra-write-root-file-write-needs-approval",
      match: {
        capabilities: ["filesystem.write"],
        pathScopes: ["write_root"]
      },
      priority: 75
    },
    {
      description: "Public read-only web fetches are allowed by default.",
      effect: "allow",
      id: "public-web-fetch-allow",
      match: {
        capabilities: ["network.fetch_public_readonly"]
      },
      priority: 80
    },
    {
      description: "Low-risk internal reads are allowed.",
      effect: "allow",
      id: "file-read-allow",
      match: {
        capabilities: ["filesystem.read"],
        pathScopes: ["workspace", "write_root"]
      },
      priority: 70
    }
  ],
  source: "local"
};
