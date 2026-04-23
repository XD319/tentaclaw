import { spawn } from "node:child_process";

import { AppError } from "../../runtime/app-error.js";

export interface ShellExecutionRequest {
  command: string;
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface ShellExecutionResult {
  durationMs: number;
  exitCode: number;
  stderr: string;
  stderrTruncated: boolean;
  stdout: string;
  stdoutTruncated: boolean;
  timedOut: boolean;
}

export interface ShellExecutorConfig {
  maxOutputBytes?: number;
  shellExecutable?: string;
  shellArgs?: string[];
  /**
   * Host environment variables that may be forwarded into the child process.
   * Defaults to a small, safe set that does NOT include secrets.
   */
  inheritedEnvKeys?: string[];
}

/**
 * Default host env keys that are safe to forward into shell commands.
 * Anything not on this list (including API keys, tokens, cloud creds) is
 * intentionally stripped so that tool commands cannot read them via `echo $SECRET`.
 */
export const DEFAULT_INHERITED_ENV_KEYS: readonly string[] = Object.freeze([
  "CI",
  "COMSPEC",
  "FORCE_COLOR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "NODE_ENV",
  "NO_COLOR",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PUBLIC",
  "PWD",
  "SHELL",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TZ",
  "USER",
  "USERNAME",
  "USERPROFILE",
  "WINDIR"
]);

/**
 * Env var name patterns that are NEVER forwarded even if they appear in
 * inheritedEnvKeys. Acts as a defense-in-depth trap for common secret naming.
 */
const SENSITIVE_ENV_PATTERNS: readonly RegExp[] = [
  /key/i,
  /token/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /credential/i,
  /_pat$/i,
  /^npm_/i,
  /^aws_/i,
  /^gcp_/i,
  /^azure_/i,
  /^github_/i,
  /^openai_/i,
  /^anthropic_/i,
  /^gemini_/i,
  /^agent_/i
];

export function buildChildEnv(
  hostEnv: NodeJS.ProcessEnv,
  additionalEnv: Record<string, string>,
  inheritedEnvKeys: readonly string[] = DEFAULT_INHERITED_ENV_KEYS
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of inheritedEnvKeys) {
    if (SENSITIVE_ENV_PATTERNS.some((pattern) => pattern.test(key))) {
      continue;
    }
    const value = hostEnv[key];
    if (typeof value === "string" && value.length > 0) {
      result[key] = value;
    }
  }
  for (const [key, value] of Object.entries(additionalEnv)) {
    result[key] = value;
  }
  return result;
}

export interface ShellCommandExecutor {
  execute(request: ShellExecutionRequest): Promise<ShellExecutionResult>;
}

export class ShellExecutor implements ShellCommandExecutor {
  private readonly maxOutputBytes: number;
  private readonly shellExecutable: string;
  private readonly shellArgs: string[];
  private readonly inheritedEnvKeys: readonly string[];

  public constructor(config: ShellExecutorConfig = {}) {
    this.maxOutputBytes = config.maxOutputBytes ?? 200_000;
    const defaultShell = resolveDefaultShellConfig();
    this.shellExecutable = config.shellExecutable ?? defaultShell.executable;
    this.shellArgs = config.shellArgs ?? defaultShell.args;
    this.inheritedEnvKeys = config.inheritedEnvKeys ?? DEFAULT_INHERITED_ENV_KEYS;
  }

  public execute(request: ShellExecutionRequest): Promise<ShellExecutionResult> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const child = spawn(this.shellExecutable, [...this.shellArgs, request.command], {
        cwd: request.cwd,
        env: buildChildEnv(process.env, request.env, this.inheritedEnvKeys),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });

      let stdout = "";
      let stderr = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let settled = false;

      const finish = (handler: () => void): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutHandle);
        request.signal.removeEventListener("abort", onAbort);
        handler();
      };

      const onAbort = (): void => {
        child.kill();
        finish(() => {
          reject(
            new AppError({
              code: timedOut ? "timeout" : "interrupt",
              message: timedOut ? "Shell command timed out." : "Shell command interrupted."
            })
          );
        });
      };

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        onAbort();
      }, request.timeoutMs);

      request.signal.addEventListener("abort", onAbort);

      child.stdout.on("data", (chunk: Buffer) => {
        const updated = appendWithLimit(stdout, chunk, this.maxOutputBytes);
        stdout = updated.value;
        stdoutTruncated = stdoutTruncated || updated.truncated;
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const updated = appendWithLimit(stderr, chunk, this.maxOutputBytes);
        stderr = updated.value;
        stderrTruncated = stderrTruncated || updated.truncated;
      });

      child.once("error", (error) => {
        finish(() => {
          reject(
            new AppError({
              cause: error,
              code: "tool_execution_error",
              message: `Shell execution failed: ${error.message}`
            })
          );
        });
      });

      child.once("close", (exitCode) => {
        finish(() => {
          resolve({
            durationMs: Date.now() - startedAt,
            exitCode: exitCode ?? -1,
            stderr,
            stderrTruncated,
            stdout,
            stdoutTruncated,
            timedOut
          });
        });
      });
    });
  }
}

function resolveDefaultShellConfig(): { args: string[]; executable: string } {
  if (process.platform === "win32") {
    return {
      args: ["-NoProfile", "-Command"],
      executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    };
  }

  return {
    args: ["-lc"],
    executable: "/bin/sh"
  };
}

function appendWithLimit(
  current: string,
  chunk: Buffer,
  maxOutputBytes: number
): { value: string; truncated: boolean } {
  const combined = current + chunk.toString("utf8");
  if (combined.length <= maxOutputBytes) {
    return {
      truncated: false,
      value: combined
    };
  }

  return {
    truncated: true,
    value: combined.slice(0, maxOutputBytes)
  };
}
