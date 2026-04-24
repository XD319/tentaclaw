export const TOOL_RISK_LEVELS = ["low", "medium", "high"] as const;

export type ToolRiskLevel = (typeof TOOL_RISK_LEVELS)[number];

export const TOOL_CAPABILITIES = [
  "filesystem.read",
  "filesystem.write",
  "network.fetch_public_readonly",
  "shell.execute",
  "mcp.invoke"
] as const;

export type ToolCapability = (typeof TOOL_CAPABILITIES)[number];

export const PRIVACY_LEVELS = ["public", "internal", "restricted"] as const;

export type PrivacyLevel = (typeof PRIVACY_LEVELS)[number];

export const PATH_SCOPES = [
  "workspace",
  "write_root",
  "outside_workspace",
  "outside_write_root",
  "network"
] as const;

export type PathScope = (typeof PATH_SCOPES)[number];
