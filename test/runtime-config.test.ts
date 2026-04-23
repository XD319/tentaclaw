import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApplication, resolveRuntimeConfig } from "../src/runtime/index.js";
import { SandboxService } from "../src/sandbox/sandbox-service.js";

const tempPaths: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined) {
      await fs.rm(tempPath, { force: true, recursive: true });
    }
  }
});

describe("runtime config", () => {
  it("defaults fetch hosts to open web_fetch and uses larger coding budgets", async () => {
    const workspaceRoot = await createTempWorkspace();
    const config = resolveRuntimeConfig(workspaceRoot);

    expect(config.allowedFetchHosts).toEqual(["*"]);
    expect(config.tokenBudget.inputLimit).toBe(64_000);
    expect(config.tokenBudget.outputLimit).toBe(8_000);

    const sandbox = new SandboxService({
      allowedFetchHosts: config.allowedFetchHosts,
      workspaceRoot
    });
    expect(sandbox.prepareWebFetch("https://not-example.test/doc").host).toBe("not-example.test");
  });

  it("loads runtime.config.json and lets env override high-impact fields", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify(
        {
          allowedFetchHosts: ["github.com"],
          defaultMaxIterations: 5,
          defaultTimeoutMs: 45_000,
          tokenBudget: {
            inputLimit: 32_000,
            outputLimit: 4_000,
            reservedOutput: 500
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const fileConfig = resolveRuntimeConfig(workspaceRoot);
    expect(fileConfig.configSource).toBe("file");
    expect(fileConfig.allowedFetchHosts).toEqual(["github.com"]);
    expect(fileConfig.defaultMaxIterations).toBe(5);
    expect(fileConfig.tokenBudget.inputLimit).toBe(32_000);

    vi.stubEnv("AGENT_ALLOWED_FETCH_HOSTS", "docs.example.com,*.githubusercontent.com");
    vi.stubEnv("AGENT_TOKEN_INPUT_LIMIT", "128000");
    const envConfig = resolveRuntimeConfig(workspaceRoot);

    expect(envConfig.configSource).toBe("env");
    expect(envConfig.allowedFetchHosts).toEqual(["docs.example.com", "*.githubusercontent.com"]);
    expect(envConfig.tokenBudget.inputLimit).toBe(128_000);
    expect(envConfig.tokenBudget.outputLimit).toBe(4_000);
  });

  it("lets explicit createApplication config override resolved runtime config", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify({
        allowedFetchHosts: ["github.com"],
        tokenBudget: {
          inputLimit: 32_000
        }
      }),
      "utf8"
    );

    const handle = createApplication(workspaceRoot, {
      config: {
        allowedFetchHosts: ["internal.example"],
        databasePath: ":memory:",
        tokenBudget: {
          inputLimit: 9_000,
          outputLimit: 3_000,
          reservedOutput: 300,
          usedInput: 0,
          usedOutput: 0
        }
      }
    });

    try {
      expect(handle.config.allowedFetchHosts).toEqual(["internal.example"]);
      expect(handle.config.tokenBudget.inputLimit).toBe(9_000);
    } finally {
      handle.close();
    }
  });

  it("fails fast for invalid token budget config", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify({
        tokenBudget: {
          outputLimit: 1_000,
          reservedOutput: 1_000
        }
      }),
      "utf8"
    );

    expect(() => resolveRuntimeConfig(workspaceRoot)).toThrow(/reservedOutput/);
  });
});

async function createTempWorkspace(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-runtime-config-"));
  tempPaths.push(workspaceRoot);
  return workspaceRoot;
}
