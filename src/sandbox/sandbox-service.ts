import { homedir } from "node:os";
import { isIP } from "node:net";
import { basename, dirname, isAbsolute, parse, relative, resolve } from "node:path";

import { AppError } from "../runtime/app-error.js";
import type {
  JsonObject,
  PathScope,
  SandboxFileAccessPlan,
  SandboxShellPlan,
  SandboxWebPlan
} from "../types/index.js";

export interface SandboxConfig {
  workspaceRoot: string;
  readRoots?: string[];
  writeRoots?: string[];
  allowedEnvKeys?: string[];
  allowedShellCommands?: string[];
  deniedShellPatterns?: RegExp[];
  maxShellTimeoutMs?: number;
  allowedFetchHosts?: string[];
  shellNetworkAccess?: "disabled" | "unrestricted";
}

export interface ShellSandboxRequest {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface PreparedShellInput {
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  executable: string;
  sandboxPlan: SandboxShellPlan;
}

export class SandboxService {
  private readonly workspaceRoot: string;
  private readonly readRoots: string[];
  private readonly writeRoots: string[];
  private readonly allowedEnvKeys: Set<string>;
  private readonly allowedShellCommands: Set<string>;
  private readonly deniedShellPatterns: RegExp[];
  private readonly maxShellTimeoutMs: number;
  private readonly allowedFetchHosts: Set<string>;
  private readonly allowedFetchHostPatterns: RegExp[];
  private readonly shellNetworkAccess: "disabled" | "unrestricted";

  public constructor(config: SandboxConfig) {
    this.workspaceRoot = resolve(config.workspaceRoot);
    this.readRoots = normalizeRoots([this.workspaceRoot, ...(config.readRoots ?? [])]);
    this.writeRoots = normalizeRoots(config.writeRoots ?? [this.workspaceRoot]);
    for (const root of this.writeRoots) {
      this.assertSafeRoot(root, "write root");
    }
    this.allowedEnvKeys = new Set(config.allowedEnvKeys ?? []);
    this.allowedShellCommands = new Set(
      (config.allowedShellCommands ?? [
        "cat",
        "cp",
        "dir",
        "echo",
        "eslint",
        "findstr",
        "git",
        "get-childitem",
        "get-content",
        "jest",
        "ls",
        "mkdir",
        "mv",
        "node",
        "npm",
        "pnpm",
        "prettier",
        "pwd",
        "python",
        "pytest",
        "rimraf",
        "ruff",
        "select-string",
        "tsc",
        "type",
        "where",
        "whoami",
        "yarn"
      ]).map((entry) => entry.toLowerCase())
    );
    this.deniedShellPatterns =
      config.deniedShellPatterns ?? [
        /\bdel\b/i,
        /\bformat\b/i,
        /\bremove-item\b/i,
        /\brd\b/i,
        /\brm\b/i,
        /\brmdir\b/i,
        /\bshutdown\b/i,
        /\bstop-process\b/i,
        /\btaskkill\b/i,
        /\bcurl\b/i,
        /\binvoke-webrequest\b/i,
        /\bwget\b/i,
        /\bping\b/i,
        /\bssh\b/i
      ];
    this.maxShellTimeoutMs = config.maxShellTimeoutMs ?? 30_000;
    this.allowedFetchHosts = new Set(
      (config.allowedFetchHosts ?? []).map((host) => host.toLowerCase())
    );
    this.allowedFetchHostPatterns = [...this.allowedFetchHosts]
      .filter((host) => host.includes("*"))
      .map((pattern) => wildcardHostToRegExp(pattern));
    this.shellNetworkAccess = config.shellNetworkAccess ?? "unrestricted";
  }

  public prepareFileRead(candidatePath: string, cwd: string): SandboxFileAccessPlan {
    const resolvedPath = resolve(cwd, candidatePath);
    const pathScope = this.classifyReadScope(resolvedPath);
    if (pathScope === "outside_workspace") {
      throw this.createSandboxError(
        "sandbox_denied",
        `Read path ${resolvedPath} is outside the workspace root and configured read roots. Use --cwd for the workspace or add an explicit read root in .auto-talon/sandbox.config.json.`,
        {
          kind: "file",
          operation: "read",
          pathScope,
          requestedPath: candidatePath,
          resolvedPath
        }
      );
    }

    return {
      kind: "file",
      operation: "read",
      pathScope,
      requestedPath: candidatePath,
      resolvedPath,
      withinExtraWriteRoot: this.isWithinExtraWriteRoot(resolvedPath)
    };
  }

  public prepareFileWrite(candidatePath: string, cwd: string): SandboxFileAccessPlan {
    const resolvedPath = resolve(cwd, candidatePath);
    const pathScope = this.classifyWriteScope(resolvedPath);
    if (pathScope === "outside_workspace" || pathScope === "outside_write_root") {
      throw this.createSandboxError(
        "sandbox_denied",
        `Write path ${resolvedPath} is outside the configured write roots. Use --cwd for workspace writes or pass --write-root ${dirname(resolvedPath)} to authorize this location explicitly.`,
        {
          kind: "file",
          operation: "write",
          pathScope,
          requestedPath: candidatePath,
          resolvedPath
        }
      );
    }

    return {
      kind: "file",
      operation: "write",
      pathScope,
      requestedPath: candidatePath,
      resolvedPath,
      withinExtraWriteRoot: this.isWithinExtraWriteRoot(resolvedPath)
    };
  }

  public prepareShellExecution(request: ShellSandboxRequest): PreparedShellInput {
    assertNoShellChaining(request.command);
    for (const pattern of this.deniedShellPatterns) {
      if (pattern.test(request.command)) {
        throw this.createSandboxError(
          "sandbox_denied",
          `Shell command denied by sandbox: ${request.command}`,
          {
            kind: "shell",
            reason: `Command matched ${pattern.toString()}`
          }
        );
      }
    }

    const executable = extractExecutable(request.command).toLowerCase();
    if (!this.allowedShellCommands.has(executable)) {
      throw this.createSandboxError(
        "sandbox_denied",
        `Command ${executable} is not in the sandbox allowlist.`,
        {
          executable,
          kind: "shell"
        }
      );
    }
    assertExecutableArgsPolicy(executable, request.command);

    const cwd = resolve(request.cwd);
    const pathScope = this.classifyReadScope(cwd);
    if (pathScope === "outside_workspace") {
      throw this.createSandboxError(
        "sandbox_denied",
        `Shell cwd ${cwd} is outside the workspace root.`,
        {
          cwd,
          kind: "shell",
          pathScope
        }
      );
    }

    const env = this.sanitizeEnv(request.env);
    const timeoutMs = this.clampTimeout(request.timeoutMs);
    const sandboxPlan: SandboxShellPlan = {
      command: request.command,
      cwd,
      envKeys: Object.keys(env),
      executable,
      kind: "shell",
      networkAccess: this.shellNetworkAccess,
      pathScope,
      timeoutMs
    };

    return {
      command: request.command,
      cwd,
      env,
      executable,
      sandboxPlan,
      timeoutMs
    };
  }

  public prepareWebFetch(url: string): SandboxWebPlan {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch (error) {
      throw new AppError({
        cause: error,
        code: "tool_validation_error",
        message: `Invalid URL for web fetch: ${url}`
      });
    }

    const protocol = parsedUrl.protocol.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") {
      throw this.createSandboxError(
        "sandbox_denied",
        `Protocol ${parsedUrl.protocol} is not allowed for web fetch.`,
        {
          host: parsedUrl.host,
          kind: "network",
          protocol: parsedUrl.protocol,
          url
        }
      );
    }

    const hostname = parsedUrl.hostname.toLowerCase();
    const restrictedReason = classifyRestrictedFetchTarget(hostname);
    if (restrictedReason !== null) {
      throw this.createSandboxError(
        "sandbox_denied",
        `Host ${hostname} is blocked for web fetch: ${restrictedReason}.`,
        {
          host: parsedUrl.host.toLowerCase(),
          hostname,
          kind: "network",
          url
        }
      );
    }

    const host = parsedUrl.host.toLowerCase();
    if (!this.isAllowedFetchHost(host)) {
      throw this.createSandboxError(
        "sandbox_denied",
        `Host ${host} is not in the allowed fetch list.`,
        {
          host,
          kind: "network",
          url
        }
      );
    }

    return {
      host,
      kind: "network",
      method: "GET",
      networkAccess: "controlled",
      pathScope: "network",
      url: parsedUrl.toString()
    };
  }

  private isAllowedFetchHost(host: string): boolean {
    if (this.allowedFetchHosts.has("*")) {
      return true;
    }

    if (this.allowedFetchHosts.has(host)) {
      return true;
    }

    return this.allowedFetchHostPatterns.some((pattern) => pattern.test(host));
  }

  private sanitizeEnv(env: Record<string, string> | undefined): Record<string, string> {
    if (env === undefined) {
      return {};
    }

    const sanitizedEntries = Object.entries(env).filter(([key]) =>
      this.allowedEnvKeys.has(key)
    );

    if (sanitizedEntries.length !== Object.keys(env).length) {
      throw this.createSandboxError(
        "sandbox_denied",
        "Shell env contains keys outside the allowlist.",
        {
          allowedEnvKeys: [...this.allowedEnvKeys],
          kind: "shell"
        }
      );
    }

    return Object.fromEntries(sanitizedEntries);
  }

  private clampTimeout(timeoutMs: number | undefined): number {
    if (timeoutMs === undefined) {
      return this.maxShellTimeoutMs;
    }

    if (timeoutMs <= 0 || timeoutMs > this.maxShellTimeoutMs) {
      throw this.createSandboxError(
        "sandbox_denied",
        `Shell timeout ${timeoutMs}ms exceeds sandbox limit ${this.maxShellTimeoutMs}ms.`,
        {
          kind: "shell",
          maxTimeoutMs: this.maxShellTimeoutMs,
          timeoutMs
        }
      );
    }

    return timeoutMs;
  }

  private classifyReadScope(resolvedPath: string): PathScope {
    if (this.isWithinRoot(resolvedPath, this.workspaceRoot)) {
      return "workspace";
    }

    return this.readRoots.some((root) => this.isWithinRoot(resolvedPath, root))
      ? "write_root"
      : "outside_workspace";
  }

  private classifyWriteScope(resolvedPath: string): PathScope {
    if (this.isWithinRoot(resolvedPath, this.workspaceRoot)) {
      return "workspace";
    }

    if (this.writeRoots.some((root) => this.isWithinRoot(resolvedPath, root))) {
      return "write_root";
    }

    return "outside_workspace";
  }

  private isWithinRoot(candidatePath: string, rootPath: string): boolean {
    const relativePath = relative(rootPath, candidatePath);
    return (
      relativePath.length === 0 ||
      (!relativePath.startsWith("..\\") &&
        !relativePath.startsWith("../") &&
        relativePath !== ".." &&
        !isAbsolute(relativePath))
    );
  }

  private createSandboxError(
    code: "sandbox_denied" | "tool_validation_error",
    message: string,
    sandbox: JsonObject
  ): AppError {
    return new AppError({
      code,
      details: {
        sandbox
      },
      message
    });
  }

  private isWithinExtraWriteRoot(resolvedPath: string): boolean {
    return this.writeRoots
      .filter((root) => !this.isWithinRoot(root, this.workspaceRoot))
      .some((root) => this.isWithinRoot(resolvedPath, root));
  }

  private assertSafeRoot(rootPath: string, label: string): void {
    const parsed = parse(rootPath);
    const normalized = rootPath.toLowerCase();
    const homeRoot = resolve(homedir()).toLowerCase();

    if (normalized === parsed.root.toLowerCase()) {
      throw this.createSandboxError("sandbox_denied", `Refusing to use filesystem root as ${label}: ${rootPath}`, {
        kind: "file",
        rootPath
      });
    }

    if (normalized === homeRoot) {
      throw this.createSandboxError("sandbox_denied", `Refusing to use the user home directory as ${label}: ${rootPath}`, {
        kind: "file",
        rootPath
      });
    }

    if (basename(rootPath).toLowerCase() === ".git" || normalized.includes("\\.git\\") || normalized.includes("/.git/")) {
      throw this.createSandboxError("sandbox_denied", `Refusing to use a Git metadata directory as ${label}: ${rootPath}`, {
        kind: "file",
        rootPath
      });
    }

    if (basename(rootPath).toLowerCase() === ".ssh" || normalized.includes("\\.ssh\\") || normalized.includes("/.ssh/")) {
      throw this.createSandboxError("sandbox_denied", `Refusing to use an SSH key directory as ${label}: ${rootPath}`, {
        kind: "file",
        rootPath
      });
    }

    if (normalized.endsWith("/var/run/docker.sock") || normalized.endsWith("\\var\\run\\docker.sock")) {
      throw this.createSandboxError("sandbox_denied", `Refusing to use the Docker socket as ${label}: ${rootPath}`, {
        kind: "file",
        rootPath
      });
    }
  }
}

function normalizeRoots(roots: string[]): string[] {
  return [...new Set(roots.map((root) => resolve(root)))];
}

function wildcardHostToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .toLowerCase()
    .replace(/[.+?^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*/gu, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function assertNoShellChaining(command: string): void {
  const forbiddenSyntaxPatterns = [/&&/u, /\|\|/u, /;/u, /\n|\r/u, /\$\(/u, /`/u];
  if (forbiddenSyntaxPatterns.some((pattern) => pattern.test(command))) {
    throw new AppError({
      code: "sandbox_denied",
      message: "Shell command contains chaining or eval syntax that is not allowed in sandbox mode."
    });
  }
}

function assertExecutableArgsPolicy(executable: string, command: string): void {
  const lowered = command.toLowerCase();
  const deniedByExecutable: Record<string, RegExp[]> = {
    node: [/\s--eval\b/u, /\s-e\b/u, /\s--print\b/u, /\s-p\b/u],
    powershell: [/\s-command\b/u, /\s-encodedcommand\b/u, /\s-enc\b/u],
    pwsh: [/\s-command\b/u, /\s-encodedcommand\b/u, /\s-enc\b/u],
    python: [/\s-c\b/u]
  };

  const deniedPatterns = deniedByExecutable[executable] ?? [];
  for (const pattern of deniedPatterns) {
    if (pattern.test(lowered)) {
      throw new AppError({
        code: "sandbox_denied",
        message: `Shell arguments for ${executable} violate sandbox policy.`
      });
    }
  }
}

function extractExecutable(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return "";
  }

  const match = trimmed.match(/^"([^"]+)"|^'([^']+)'|^([^\s]+)/);
  const raw = match?.[1] ?? match?.[2] ?? match?.[3];
  return raw ?? "";
}

function classifyRestrictedFetchTarget(hostname: string): string | null {
  if (
    hostname === "localhost" ||
    hostname === "localhost.localdomain" ||
    hostname === "host.docker.internal" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    return "local hostname";
  }

  if (!hostname.includes(".") && isIP(hostname) === 0) {
    return "single-label internal hostname";
  }

  const ipVersion = isIP(hostname);
  if (ipVersion === 4 && isPrivateIpv4(hostname)) {
    return "private or local IPv4 range";
  }
  if (ipVersion === 6 && isPrivateIpv6(hostname)) {
    return "private or local IPv6 range";
  }

  return null;
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map((value) => Number.parseInt(value, 10));
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return true;
  }

  const [first, second] = octets;
  if (first === undefined || second === undefined) {
    return true;
  }

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19))
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const lowered = hostname.toLowerCase();

  if (lowered === "::" || lowered === "::1") {
    return true;
  }

  if (lowered.startsWith("fc") || lowered.startsWith("fd")) {
    return true;
  }

  if (lowered.startsWith("fe8") || lowered.startsWith("fe9") || lowered.startsWith("fea") || lowered.startsWith("feb")) {
    return true;
  }

  if (lowered.startsWith("fec") || lowered.startsWith("fed") || lowered.startsWith("fee") || lowered.startsWith("fef")) {
    return true;
  }

  const mappedIpv4Prefix = "::ffff:";
  if (lowered.startsWith(mappedIpv4Prefix)) {
    return isPrivateIpv4(lowered.slice(mappedIpv4Prefix.length));
  }

  return false;
}
