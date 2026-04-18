import { resolve } from "node:path";

import { AppError } from "../runtime/app-error";
import type {
  JsonObject,
  PathScope,
  SandboxFileAccessPlan,
  SandboxShellPlan,
  SandboxWebPlan
} from "../types";

export interface SandboxConfig {
  workspaceRoot: string;
  writeRoots?: string[];
  allowedEnvKeys?: string[];
  allowedShellCommands?: string[];
  deniedShellPatterns?: RegExp[];
  maxShellTimeoutMs?: number;
  allowedFetchHosts?: string[];
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
  private readonly writeRoots: string[];
  private readonly allowedEnvKeys: Set<string>;
  private readonly allowedShellCommands: Set<string>;
  private readonly deniedShellPatterns: RegExp[];
  private readonly maxShellTimeoutMs: number;
  private readonly allowedFetchHosts: Set<string>;

  public constructor(config: SandboxConfig) {
    this.workspaceRoot = resolve(config.workspaceRoot);
    this.writeRoots = (config.writeRoots ?? [this.workspaceRoot]).map((root) => resolve(root));
    this.allowedEnvKeys = new Set(config.allowedEnvKeys ?? []);
    this.allowedShellCommands = new Set(
      (config.allowedShellCommands ?? [
        "cat",
        "dir",
        "echo",
        "findstr",
        "get-childitem",
        "get-content",
        "git",
        "node",
        "npm",
        "pnpm",
        "select-string",
        "type",
        "where",
        "whoami"
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
  }

  public prepareFileRead(candidatePath: string, cwd: string): SandboxFileAccessPlan {
    const resolvedPath = resolve(cwd, candidatePath);
    const pathScope = this.classifyReadScope(resolvedPath);
    if (pathScope === "outside_workspace") {
      throw this.createSandboxError(
        "sandbox_denied",
        `Read path ${resolvedPath} is outside the workspace root.`,
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
      resolvedPath
    };
  }

  public prepareFileWrite(candidatePath: string, cwd: string): SandboxFileAccessPlan {
    const resolvedPath = resolve(cwd, candidatePath);
    const pathScope = this.classifyWriteScope(resolvedPath);
    if (pathScope === "outside_workspace" || pathScope === "outside_write_root") {
      throw this.createSandboxError(
        "sandbox_denied",
        `Write path ${resolvedPath} is outside the configured write roots.`,
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
      resolvedPath
    };
  }

  public prepareShellExecution(request: ShellSandboxRequest): PreparedShellInput {
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
      networkAccess: "disabled",
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

    const host = parsedUrl.host.toLowerCase();
    if (!this.allowedFetchHosts.has(host)) {
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
    return this.isWithinRoot(resolvedPath, this.workspaceRoot)
      ? "workspace"
      : "outside_workspace";
  }

  private classifyWriteScope(resolvedPath: string): PathScope {
    if (!this.isWithinRoot(resolvedPath, this.workspaceRoot)) {
      return "outside_workspace";
    }

    return this.writeRoots.some((root) => this.isWithinRoot(resolvedPath, root))
      ? "write_root"
      : "outside_write_root";
  }

  private isWithinRoot(candidatePath: string, rootPath: string): boolean {
    const normalizedCandidate = candidatePath.toLowerCase();
    const normalizedRoot = rootPath.toLowerCase();

    return (
      normalizedCandidate === normalizedRoot ||
      normalizedCandidate.startsWith(`${normalizedRoot}\\`) ||
      normalizedCandidate.startsWith(`${normalizedRoot}/`)
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
