import { spawn, spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";

import { AppError } from "../../runtime/app-error";

import type {
  ShellCommandExecutor,
  ShellExecutionRequest,
  ShellExecutionResult
} from "./shell-executor";

export interface DockerShellExecutorConfig {
  dockerImage: string;
  readRoots: string[];
  workspaceRoot: string;
  writeRoots: string[];
  maxOutputBytes?: number;
}

interface DockerMount {
  containerPath: string;
  hostPath: string;
  mode: "ro" | "rw";
}

export class DockerShellExecutor implements ShellCommandExecutor {
  private readonly dockerImage: string;
  private readonly maxOutputBytes: number;
  private readonly mounts: DockerMount[];
  private readonly workspaceRoot: string;

  public constructor(config: DockerShellExecutorConfig) {
    this.dockerImage = config.dockerImage;
    this.maxOutputBytes = config.maxOutputBytes ?? 200_000;
    this.workspaceRoot = resolve(config.workspaceRoot);
    this.mounts = buildMounts(config);
    assertDockerAvailable();
  }

  public execute(request: ShellExecutionRequest): Promise<ShellExecutionResult> {
    const cwd = mapHostPathToContainer(resolve(request.cwd), this.mounts);
    if (cwd === null) {
      throw new AppError({
        code: "sandbox_denied",
        message: `Shell cwd ${request.cwd} is not mounted in the Docker sandbox.`
      });
    }

    return new Promise((resolveResult, reject) => {
      const startedAt = Date.now();
      const args = [
        "run",
        "--rm",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--cpus",
        "1",
        "--memory",
        "512m",
        "--pids-limit",
        "128",
        ...this.mounts.flatMap((mount) => [
          "-v",
          `${mount.hostPath}:${mount.containerPath}:${mount.mode}`
        ]),
        "-w",
        cwd,
        ...Object.entries(request.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
        this.dockerImage,
        "/bin/sh",
        "-lc",
        request.command
      ];
      const child = spawn("docker", args, {
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
              message: timedOut ? "Docker shell command timed out." : "Docker shell command interrupted."
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
              message: `Docker shell execution failed: ${error.message}`
            })
          );
        });
      });

      child.once("close", (exitCode) => {
        finish(() => {
          resolveResult({
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

function assertDockerAvailable(): void {
  const result = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true
  });

  if (result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim();
    throw new AppError({
      code: "sandbox_denied",
      message: `Docker sandbox mode was requested, but Docker is not available or not running.${detail.length > 0 ? ` ${detail}` : ""}`
    });
  }
}

function buildMounts(config: DockerShellExecutorConfig): DockerMount[] {
  const mounts: DockerMount[] = [
    {
      containerPath: "/workspace",
      hostPath: resolve(config.workspaceRoot),
      mode: "rw"
    }
  ];

  for (const [index, root] of config.readRoots.entries()) {
    const hostPath = resolve(root);
    if (mounts.some((mount) => samePath(mount.hostPath, hostPath))) {
      continue;
    }

    mounts.push({
      containerPath: `/read-root-${index}`,
      hostPath,
      mode: "ro"
    });
  }

  for (const [index, root] of config.writeRoots.entries()) {
    const hostPath = resolve(root);
    if (mounts.some((mount) => samePath(mount.hostPath, hostPath))) {
      continue;
    }

    mounts.push({
      containerPath: `/write-root-${index}`,
      hostPath,
      mode: "rw"
    });
  }

  return mounts;
}

function mapHostPathToContainer(hostPath: string, mounts: DockerMount[]): string | null {
  const match = mounts
    .filter((mount) => isWithinRoot(hostPath, mount.hostPath))
    .sort((left, right) => right.hostPath.length - left.hostPath.length)[0];

  if (match === undefined) {
    return null;
  }

  const remainder = relative(match.hostPath, hostPath).replace(/\\/gu, "/");
  return remainder.length === 0 ? match.containerPath : `${match.containerPath}/${remainder}`;
}

function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith("..\\") &&
      !relativePath.startsWith("../") &&
      relativePath !== ".." &&
      !isAbsolute(relativePath))
  );
}

function samePath(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
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
