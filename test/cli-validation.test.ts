import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const tempPaths: string[] = [];
const cliBin = join(process.cwd(), "src", "cli", "bin.ts");
const tsxLoader = pathToFileURL(join(process.cwd(), "node_modules", "tsx", "dist", "loader.mjs")).href;

afterEach(() => {
  delete process.env.AGENT_FEISHU_APP_ID;
  delete process.env.AGENT_FEISHU_APP_SECRET;

  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined) {
      rmSync(tempPath, { force: true, recursive: true });
    }
  }
});

describe("cli validation and read-only commands", () => {
  it("does not initialize a workspace for version output", () => {
    const workspace = createTempDir("talon-version-no-init-");
    const result = runCli(workspace, ["version"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("auto-talon v0.1.1");
    expect(existsSync(join(workspace, ".auto-talon"))).toBe(false);
  });

  it("rejects invalid numeric run options before touching storage", () => {
    const workspace = createTempDir("talon-invalid-number-");
    const result = runCli(workspace, ["run", "hello", "--max-iterations", "abc"]);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("--max-iterations must be a positive integer");
    expect(output).not.toContain("NOT NULL constraint failed");
  });

  it("lists feishu adapter when credentials are provided through env", () => {
    const workspace = createTempDir("talon-feishu-env-");
    const result = runCli(workspace, ["gateway", "list-adapters"], {
      AGENT_FEISHU_APP_ID: "fake-app",
      AGENT_FEISHU_APP_SECRET: "fake-secret"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("feishu");
  });

  it("reuses provider setup from user config in a new workspace", () => {
    const setupWorkspace = createTempDir("talon-provider-setup-");
    const freshWorkspace = createTempDir("talon-provider-fresh-");
    const userConfigDir = createTempDir("talon-provider-user-config-");
    const env = {
      AGENT_PROVIDER: undefined,
      AGENT_USER_CONFIG_DIR: userConfigDir
    };

    const setup = runCli(
      setupWorkspace,
      [
        "provider",
        "setup",
        "openai",
        "--api-key",
        "sk-user-test",
        "--model",
        "gpt-user-test",
        "--timeout-ms",
        "30000",
        "--stream-idle-timeout-ms",
        "345000"
      ],
      env
    );
    const providerConfig = JSON.parse(
      readFileSync(join(userConfigDir, "provider.config.json"), "utf8")
    ) as {
      currentProvider?: string;
      providers?: Record<string, { apiKey?: string; contextWindowTokens?: number; model?: string; streamIdleTimeoutMs?: number }>;
    };

    expect(setup.status).toBe(0);
    expect(setup.stdout).toContain("Configured user provider: openai");
    expect(existsSync(join(setupWorkspace, ".auto-talon"))).toBe(false);
    expect(providerConfig.currentProvider).toBe("openai");
    expect(providerConfig.providers?.openai).toMatchObject({
      apiKey: "sk-user-test",
      model: "gpt-user-test",
      streamIdleTimeoutMs: 345_000
    });

    const status = runCli(freshWorkspace, ["provider", "status"], env);

    expect(status.status).toBe(0);
    expect(status.stdout).toContain("Provider: openai");
    expect(status.stdout).toContain("Model: gpt-user-test");
    expect(status.stdout).toContain("Config Source: user");
    expect(status.stdout).toContain("Request Timeout (ms): 30000");
    expect(status.stdout).toContain("Stream Idle Timeout (ms): 345000");
    expect(status.stdout).toContain("Timeout Hint:");

    const use = runCli(freshWorkspace, ["provider", "use", "mock"], env);
    const nextStatus = runCli(createTempDir("talon-provider-next-"), ["provider", "status"], env);

    expect(use.status).toBe(0);
    expect(use.stdout).toContain("Selected user provider: mock");
    expect(nextStatus.status).toBe(0);
    expect(nextStatus.stdout).toContain("Provider: mock");
    expect(nextStatus.stdout).toContain("Config Source: user");
  });

  it("promotes the effective workspace provider config to user defaults", () => {
    const workspace = createTempDir("talon-provider-promote-");
    const freshWorkspace = createTempDir("talon-provider-promoted-fresh-");
    const userConfigDir = createTempDir("talon-provider-promoted-user-config-");
    const env = {
      AGENT_PROVIDER: undefined,
      AGENT_USER_CONFIG_DIR: userConfigDir
    };

    const setup = runCli(
      workspace,
      [
        "provider",
        "setup",
        "openai-compatible",
        "--workspace",
        "--api-key",
        "sk-workspace-test",
        "--base-url",
        "https://provider.example.test/v1",
        "--context-window-tokens",
        "200000",
        "--model",
        "workspace-model"
      ],
      env
    );
    const promote = runCli(workspace, ["provider", "promote"], env);
    const status = runCli(freshWorkspace, ["provider", "status"], env);

    expect(setup.status).toBe(0);
    expect(promote.status).toBe(0);
    expect(promote.stdout).toContain("Promoted user provider: openai-compatible");
    expect(status.status).toBe(0);
    expect(status.stdout).toContain("Provider: openai-compatible");
    expect(status.stdout).toContain("Model: workspace-model");
    expect(status.stdout).toContain("Base URL: https://provider.example.test/v1");
    expect(status.stdout).toContain("Context Window Tokens: 200000");
    expect(status.stdout).toContain("Config Source: user");
  });

  it("smokes the active mock provider through a post-tool request", () => {
    const workspace = createTempDir("talon-provider-smoke-");
    const result = runCli(workspace, ["provider", "smoke"], {
      AGENT_PROVIDER: "mock"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Provider: mock");
    expect(result.stdout).toContain("Success: yes");
    expect(result.stdout).toContain("Provider Error Category: -");
  });

  it("shows workspace git changes without initializing runtime storage", () => {
    const workspace = createTempDir("talon-workspace-changes-");
    spawnSync("git", ["init"], { cwd: workspace, encoding: "utf8" });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: workspace, encoding: "utf8" });
    spawnSync("git", ["config", "user.name", "Test User"], { cwd: workspace, encoding: "utf8" });
    const result = runCli(workspace, ["workspace", "changes"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Git status:");
    expect(result.stdout).toContain("clean");
    expect(result.stdout).toContain("Unstaged diff:");
    expect(existsSync(join(workspace, ".auto-talon"))).toBe(false);
  });
});

function createTempDir(prefix: string): string {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  tempPaths.push(workspace);
  return workspace;
}

function runCli(
  cwd: string,
  args: string[],
  env: Record<string, string | undefined> = {}
): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--import", tsxLoader, cliBin, ...args],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        ...env
      }
    }
  );
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout
  };
}
