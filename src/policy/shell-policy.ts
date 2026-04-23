import { AppError } from "../runtime/app-error.js";

export interface ShellPolicyConfig {
  allowedCommands?: string[];
  allowedEnvKeys?: string[];
  deniedPatterns?: RegExp[];
  maxTimeoutMs?: number;
}

export class ShellPolicy {
  private readonly allowedCommands: Set<string>;
  private readonly allowedEnvKeys: Set<string>;
  private readonly deniedPatterns: RegExp[];
  private readonly maxTimeoutMs: number;

  public constructor(config: ShellPolicyConfig = {}) {
    this.allowedCommands = new Set(
      (config.allowedCommands ?? [
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
    this.allowedEnvKeys = new Set(config.allowedEnvKeys ?? []);
    this.deniedPatterns =
      config.deniedPatterns ?? [
        /\bdel\b/i,
        /\bformat\b/i,
        /\bremove-item\b/i,
        /\brd\b/i,
        /\brm\b/i,
        /\brmdir\b/i,
        /\bshutdown\b/i,
        /\bstop-process\b/i,
        /\btaskkill\b/i
      ];
    this.maxTimeoutMs = config.maxTimeoutMs ?? 30_000;
  }

  public validateCommand(command: string): string {
    for (const pattern of this.deniedPatterns) {
      if (pattern.test(command)) {
        throw new AppError({
          code: "policy_denied",
          message: `Shell command denied by policy: ${command}`
        });
      }
    }

    const executable = extractExecutable(command).toLowerCase();
    if (!this.allowedCommands.has(executable)) {
      throw new AppError({
        code: "policy_denied",
        message: `Command ${executable} is not in the shell allowlist.`,
        details: {
          executable
        }
      });
    }

    return executable;
  }

  public sanitizeEnv(env: Record<string, string> | undefined): Record<string, string> {
    if (env === undefined) {
      return {};
    }

    const sanitizedEntries = Object.entries(env).filter(([key]) =>
      this.allowedEnvKeys.has(key)
    );

    if (sanitizedEntries.length !== Object.keys(env).length) {
      throw new AppError({
        code: "policy_denied",
        message: "Shell env contains keys outside the allowlist."
      });
    }

    return Object.fromEntries(sanitizedEntries);
  }

  public clampTimeout(timeoutMs: number | undefined): number {
    if (timeoutMs === undefined) {
      return this.maxTimeoutMs;
    }

    if (timeoutMs <= 0 || timeoutMs > this.maxTimeoutMs) {
      throw new AppError({
        code: "policy_denied",
        message: `Shell timeout ${timeoutMs}ms exceeds policy limit ${this.maxTimeoutMs}ms.`
      });
    }

    return timeoutMs;
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
