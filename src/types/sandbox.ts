import type { JsonObject } from "./common.js";
import type { PathScope } from "./governance.js";

export interface SandboxFileAccessPlan extends JsonObject {
  kind: "file";
  operation: "read" | "write";
  requestedPath: string;
  resolvedPath: string;
  pathScope: PathScope;
  withinExtraWriteRoot?: boolean;
}

export interface SandboxShellPlan extends JsonObject {
  kind: "shell";
  command: string;
  executable: string;
  cwd: string;
  envKeys: string[];
  timeoutMs: number;
  pathScope: PathScope;
  networkAccess: "disabled" | "unrestricted";
}

export interface SandboxWebPlan extends JsonObject {
  kind: "network";
  method: "GET";
  url: string;
  host: string;
  pathScope: "network";
  networkAccess: "controlled";
}

export interface SandboxMcpPlan extends JsonObject {
  kind: "mcp";
  serverId: string;
  toolName: string;
  pathScope: "network";
  target: string;
}

export type SandboxExecutionPlan =
  | SandboxFileAccessPlan
  | SandboxShellPlan
  | SandboxWebPlan
  | SandboxMcpPlan;

export type SandboxMode = "local" | "docker";

export interface SandboxProfile extends JsonObject {
  mode: SandboxMode;
  workspaceRoot: string;
  readRoots: string[];
  writeRoots: string[];
  dockerImage: string | null;
  network: "disabled" | "controlled";
  shellAllowlist: string[];
  profileName: string | null;
  configPath: string | null;
  configSource: "defaults" | "env" | "file" | "cli";
}
