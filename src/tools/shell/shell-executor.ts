import { spawn } from "node:child_process";

import { AppError } from "../../runtime/app-error";

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
}

export class ShellExecutor {
  private readonly maxOutputBytes: number;
  private readonly shellExecutable: string;
  private readonly shellArgs: string[];

  public constructor(config: ShellExecutorConfig = {}) {
    this.maxOutputBytes = config.maxOutputBytes ?? 200_000;
    this.shellExecutable =
      config.shellExecutable ?? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    this.shellArgs = config.shellArgs ?? ["-NoProfile", "-Command"];
  }

  public execute(request: ShellExecutionRequest): Promise<ShellExecutionResult> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const child = spawn(this.shellExecutable, [...this.shellArgs, request.command], {
        cwd: request.cwd,
        env: {
          ...process.env,
          ...request.env
        },
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
