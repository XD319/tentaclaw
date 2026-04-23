import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { DockerShellExecutor } from "../src/tools/shell/docker-shell-executor.js";

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined) {
      await fs.rm(tempPath, { force: true, recursive: true });
    }
  }
});

describe.skipIf(process.env.DOCKER_TEST !== "1")("Docker shell backend", () => {
  it("runs shell commands in a container with readonly and writable mounts", async () => {
    const workspaceRoot = await createTempDir("auto-talon-docker-workspace-");
    const readRoot = await createTempDir("auto-talon-docker-read-");
    const writeRoot = await createTempDir("auto-talon-docker-write-");
    await fs.writeFile(join(readRoot, "read.txt"), "readonly", "utf8");

    const executor = new DockerShellExecutor({
      dockerImage: process.env.AGENT_DOCKER_IMAGE ?? "alpine:3.20",
      readRoots: [readRoot],
      workspaceRoot,
      writeRoots: [writeRoot]
    });
    const result = await executor.execute({
      command:
        "printf ok > out.txt && cat /read-root-0/read.txt && if printf no > /read-root-0/read.txt 2>/dev/null; then exit 7; fi",
      cwd: writeRoot,
      env: {},
      signal: new AbortController().signal,
      timeoutMs: 10_000
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("readonly");
    expect(await fs.readFile(join(writeRoot, "out.txt"), "utf8")).toBe("ok");
    expect(await fs.readFile(join(readRoot, "read.txt"), "utf8")).toBe("readonly");
  });
});

async function createTempDir(prefix: string): Promise<string> {
  const tempPath = await fs.mkdtemp(join(tmpdir(), prefix));
  tempPaths.push(tempPath);
  return tempPath;
}
