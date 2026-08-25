import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApplication, resolveAppConfig, resolveRuntimeConfig } from "../src/runtime/index.js";
import { RuntimeDoctorService } from "../src/runtime/operations/runtime-doctor-service.js";
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
  it("defaults fetch hosts to open web_extract and uses larger coding budgets", async () => {
    const workspaceRoot = await createTempWorkspace();
    const config = resolveRuntimeConfig(workspaceRoot);

    expect(config.allowedFetchHosts).toEqual(["*"]);
    expect(config.tokenBudget.inputLimit).toBe(64_000);
    expect(config.tokenBudget.outputLimit).toBe(8_000);
    expect(config.compact.messageThreshold).toBe(100);
    expect(config.compact.thresholdRatio).toBe(0.75);
    expect(config.compact.targetRatio).toBe(0.2);
    expect(config.compact.protectFirstN).toBe(3);
    expect(config.compact.protectLastN).toBe(20);
    expect(config.compact.hygieneThresholdRatio).toBe(0.85);
    expect(config.compact.compactCooldownIterations).toBe(2);
    expect(config.compact.minTokenPressureRatio).toBe(0.5);
    expect(config.context.engine).toBe("hermes_compressor");
    expect(config.contextRetention.toolOutputMaxTokens).toBe(2_500);
    expect(config.tui.statusLine.style).toBe("standard");
    expect(config.tui.statusLine.type).toBe("builtin");
    expect(config.tui.statusLine.showCost).toBe(false);
    expect(config.web.backend).toBe("auto");
    expect(config.web.searchBackend).toBe("ddgs");

    const sandbox = new SandboxService({
      allowedFetchHosts: config.allowedFetchHosts,
      workspaceRoot
    });
    expect(sandbox.prepareWebFetch("https://not-example.test/doc").host).toBe("not-example.test");
    expect(() => sandbox.prepareWebFetch("http://127.0.0.1:11434/v1")).toThrow(/blocked for web fetch/i);
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
          workflow: {
            maxShellTimeoutMs: 90_000,
            shellBackend: "git-bash",
            longRunningCommands: [
              {
                command: "npm run dev",
                cwd: "web",
                env: {
                  NODE_ENV: "development"
                },
                name: "dev"
              }
            ],
            testCommands: [
              {
                category: "test",
                command: "node check.js",
                name: "test",
                timeoutMs: 60_000
              }
            ]
          },
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
    expect(fileConfig.workflow.maxShellTimeoutMs).toBe(90_000);
    expect(fileConfig.workflow.shellBackend).toBe("git-bash");
    expect(fileConfig.workflow.longRunningCommands).toEqual([
      {
        command: "npm run dev",
        cwd: "web",
        env: {
          NODE_ENV: "development"
        },
        name: "dev"
      }
    ]);
    expect(fileConfig.workflow.testCommands).toEqual([
      {
        category: "test",
        command: "node check.js",
        name: "test",
        timeoutMs: 60_000
      }
    ]);
    expect(fileConfig.tokenBudget.inputLimit).toBe(32_000);

    vi.stubEnv("AGENT_ALLOWED_FETCH_HOSTS", "docs.example.com,*.githubusercontent.com");
    vi.stubEnv("AGENT_SHELL_BACKEND", "cmd");
    vi.stubEnv("AGENT_SHELL_MAX_TIMEOUT_MS", "180000");
    vi.stubEnv("AGENT_TOKEN_INPUT_LIMIT", "128000");
    const envConfig = resolveRuntimeConfig(workspaceRoot);

    expect(envConfig.configSource).toBe("env");
    expect(envConfig.allowedFetchHosts).toEqual(["docs.example.com", "*.githubusercontent.com"]);
    expect(envConfig.workflow.shellBackend).toBe("cmd");
    expect(envConfig.workflow.maxShellTimeoutMs).toBe(180_000);
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

  it("fails fast when reservedOutput is not lower than inputLimit", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify({
        tokenBudget: {
          inputLimit: 4_000,
          reservedOutput: 4_000
        }
      }),
      "utf8"
    );

    expect(() => resolveRuntimeConfig(workspaceRoot)).toThrow(/inputLimit/);
  });

  it("falls back to default workflow test commands when normalized list is empty", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify({
        workflow: {
          testCommands: ["   ", "\t"]
        }
      }),
      "utf8"
    );

    const config = resolveRuntimeConfig(workspaceRoot);
    expect(config.workflow.testCommands).toEqual(["npm test", "npm run build"]);
  });

  it("reports legacy disabled web search config without a web section in doctor output", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify({
        webSearch: {
          backend: "disabled"
        }
      }),
      "utf8"
    );

    const doctor = new RuntimeDoctorService({
      allowedFetchHosts: ["*"],
      customShell: null,
      databasePath: ":memory:",
      listExperiences: () => [],
      maxShellTimeoutMs: 30_000,
      providerConfig: {
        apiKey: null,
        baseUrl: null,
        builtinProviderName: "mock",
        configPath: join(workspaceRoot, ".auto-talon", "provider.config.json"),
        configSource: "defaults",
        contextWindowSource: null,
        contextWindowTokens: 64_000,
        displayName: "Mock",
        family: "mock",
        maxRetries: 0,
        model: "mock-model",
        name: "mock",
        streamIdleTimeoutMs: 30_000,
        timeoutMs: 30_000,
        transport: "mock"
      },
      providerName: "mock",
      runtimeConfigPath: join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      runtimeConfigSource: "file",
      runtimeVersion: "test",
      shellBackend: "default",
      skillStats: () => ({ issues: [], skills: [] }),
      testCommands: [],
      testCurrentProvider: () =>
        Promise.resolve({
          apiKeyConfigured: true,
          endpointReachable: true,
          message: "ok",
          modelAvailable: true,
          modelConfigured: true,
          modelName: "mock-model",
          ok: true,
          providerName: "mock"
        }),
      tokenBudget: {
        inputLimit: 64_000,
        outputLimit: 8_000,
        reservedOutput: 1_000
      },
      deprecatedCompactBufferTokens: 0,
      workspaceRoot
    });

    const report = await doctor.configDoctor();
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Legacy webSearch.backend is disabled and no web config is present")
      ])
    );
  });

  it("warns when resolved web search uses default ddgs scraping", async () => {
    const workspaceRoot = await createTempWorkspace();
    const doctor = createMockDoctor(workspaceRoot);
    const report = await doctor.configDoctor();
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("web.searchBackend resolves to ddgs (best-effort)")
      ])
    );
  });

  it("suggests preferring API search when credentials exist but ddgs remains active", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify({
        web: {
          searchBackend: "ddgs"
        }
      }),
      "utf8"
    );
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "brave-test-key");
    const doctor = createMockDoctor(workspaceRoot);
    const report = await doctor.configDoctor();
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Detected API credentials for web search while web.searchBackend is ddgs")
      ])
    );
  });

  it("warns when deprecated compact.bufferTokens is configured", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify({
        compact: {
          bufferTokens: 4096
        }
      }),
      "utf8"
    );

    const config = resolveRuntimeConfig(workspaceRoot);
    const doctor = new RuntimeDoctorService({
      allowedFetchHosts: ["*"],
      customShell: null,
      databasePath: ":memory:",
      listExperiences: () => [],
      maxShellTimeoutMs: 30_000,
      providerConfig: {
        apiKey: null,
        baseUrl: null,
        builtinProviderName: "mock",
        configPath: join(workspaceRoot, ".auto-talon", "provider.config.json"),
        configSource: "defaults",
        contextWindowSource: null,
        contextWindowTokens: 64_000,
        displayName: "Mock",
        family: "mock",
        maxRetries: 0,
        model: "mock-model",
        name: "mock",
        streamIdleTimeoutMs: 30_000,
        timeoutMs: 30_000,
        transport: "mock"
      },
      providerName: "mock",
      runtimeConfigPath: join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      runtimeConfigSource: "file",
      runtimeVersion: "test",
      shellBackend: "default",
      skillStats: () => ({ issues: [], skills: [] }),
      testCommands: [],
      testCurrentProvider: () =>
        Promise.resolve({
          apiKeyConfigured: true,
          endpointReachable: true,
          message: "ok",
          modelAvailable: true,
          modelConfigured: true,
          modelName: "mock-model",
          ok: true,
          providerName: "mock"
        }),
      tokenBudget: config.tokenBudget,
      deprecatedCompactBufferTokens: config.compact.bufferTokens,
      workspaceRoot
    });

    const report = await doctor.configDoctor();
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("compact.bufferTokens is deprecated and has no runtime effect")
      ])
    );
  });

  it("normalizes custom shell backend config", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify({
        workflow: {
          customShell: {
            args: ["  -lc  ", ""],
            executable: "  bash  "
          },
          shellBackend: "custom"
        }
      }),
      "utf8"
    );

    const config = resolveRuntimeConfig(workspaceRoot);
    expect(config.workflow.customShell).toEqual({
      args: ["-lc"],
      executable: "bash"
    });
    expect(config.workflow.shellBackend).toBe("custom");
  });

  it("fails fast when custom shell backend has no executable", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify({
        workflow: {
          shellBackend: "custom"
        }
      }),
      "utf8"
    );

    expect(() => resolveRuntimeConfig(workspaceRoot)).toThrow(/customShell\.executable/);
  });

  it("resolves web search backend and Firecrawl key from runtime config and env", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify({
        webSearch: {
          apiUrl: "https://firecrawl.example/v1/search",
          backend: "firecrawl",
          maxResults: 8
        }
      }),
      "utf8"
    );
    vi.stubEnv("FIRECRAWL_API_KEY", "fire-key");
    const fileConfig = resolveRuntimeConfig(workspaceRoot);
    expect(fileConfig.webSearch).toMatchObject({
      apiKey: "fire-key",
      apiUrl: "https://firecrawl.example/v1/search",
      backend: "firecrawl",
      maxResults: 8
    });

    vi.stubEnv("AGENT_WEB_SEARCH_BACKEND", "disabled");
    const envConfig = resolveRuntimeConfig(workspaceRoot);
    expect(envConfig.configSource).toBe("env");
    expect(envConfig.webSearch.backend).toBe("disabled");
  });

  it("resolves unified web config with multi-provider env overrides", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify({
        web: {
          backend: "auto",
          extractBackend: "http",
          maxResults: 9,
          providers: {
            searxng: {
              apiUrl: "https://search.local/search"
            }
          },
          searchBackend: "searxng"
        }
      }),
      "utf8"
    );

    const fileConfig = resolveRuntimeConfig(workspaceRoot);
    expect(fileConfig.web.searchBackend).toBe("searxng");
    expect(fileConfig.web.extractBackend).toBe("http");
    expect(fileConfig.web.providers.searxng.apiUrl).toBe("https://search.local/search");
    expect(fileConfig.web.maxResults).toBe(9);

    vi.stubEnv("AGENT_WEB_SEARCH_BACKEND", "brave");
    vi.stubEnv("AGENT_WEB_EXTRACT_BACKEND", "tavily");
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "brave-key");
    vi.stubEnv("TAVILY_API_KEY", "tavily-key");
    const envConfig = resolveRuntimeConfig(workspaceRoot);

    expect(envConfig.web.searchBackend).toBe("brave");
    expect(envConfig.web.extractBackend).toBe("tavily");
    expect(envConfig.web.providers.brave.apiKey).toBe("brave-key");
    expect(envConfig.web.providers.tavily.apiKey).toBe("tavily-key");
  });

  it("auto-selects searxng from file-based provider apiUrl", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify({
        web: {
          backend: "auto",
          extractBackend: "http",
          providers: {
            searxng: {
              apiUrl: "https://search.local/search"
            }
          }
        }
      }),
      "utf8"
    );

    const config = resolveRuntimeConfig(workspaceRoot);
    expect(config.web.searchBackend).toBe("searxng");
    expect(config.web.providers.searxng.apiUrl).toBe("https://search.local/search");
  });

  it("loads DDGS_URL into web.providers.ddgs.apiUrl", async () => {
    const workspaceRoot = await createTempWorkspace();
    vi.stubEnv("DDGS_URL", "https://ddgs.local/search");
    const config = resolveRuntimeConfig(workspaceRoot);
    expect(config.web.providers.ddgs.apiUrl).toBe("https://ddgs.local/search");
  });

  it("reuses the nearest initialized parent workspace from nested directories", async () => {
    const workspaceRoot = await createTempWorkspace();
    const nestedCwd = join(workspaceRoot, "packages", "assistant", "src");
    delete process.env.AGENT_PROVIDER;
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "provider.config.json"),
      JSON.stringify({
        currentProvider: "glm",
        providers: {
          glm: {
            apiKey: "parent-workspace-key"
          }
        }
      }),
      "utf8"
    );
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify({
        version: 1
      }),
      "utf8"
    );
    await fs.mkdir(nestedCwd, { recursive: true });

    const config = resolveAppConfig(nestedCwd);

    expect(config.workspaceRoot).toBe(workspaceRoot);
    expect(config.provider.name).toBe("glm");
    await expect(fs.stat(join(nestedCwd, ".auto-talon"))).rejects.toThrow();
  });

  it("does not treat a provider-only parent config as an initialized workspace", async () => {
    const configParent = await createTempWorkspace();
    const nestedCwd = join(configParent, "work", "scratch");
    await fs.mkdir(join(configParent, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(configParent, ".auto-talon", "provider.config.json"),
      JSON.stringify({
        currentProvider: "glm"
      }),
      "utf8"
    );
    await fs.mkdir(nestedCwd, { recursive: true });

    const config = resolveAppConfig(nestedCwd);

    expect(config.workspaceRoot).toBe(nestedCwd);
  });

  it("lets AGENT_WORKSPACE_ROOT pin the workspace before parent discovery", async () => {
    const parentWorkspace = await createTempWorkspace();
    const explicitWorkspace = await createTempWorkspace();
    const nestedCwd = join(parentWorkspace, "nested");
    await fs.mkdir(join(parentWorkspace, ".auto-talon"), { recursive: true });
    await fs.mkdir(nestedCwd, { recursive: true });
    vi.stubEnv("AGENT_WORKSPACE_ROOT", explicitWorkspace);

    const config = resolveAppConfig(nestedCwd);

    expect(config.workspaceRoot).toBe(explicitWorkspace);
    await expect(fs.stat(join(nestedCwd, ".auto-talon"))).rejects.toThrow();
  });

  it("loads skills config from runtime.config.json and lets env override it", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify(
        {
          skills: {
            builtinRoot: "C:/tmp/builtin-skills",
            precedence: ["builtin", "local", "project", "team"],
            teamRoots: ["C:/tmp/team-skills"]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const fileConfig = resolveRuntimeConfig(workspaceRoot);
    expect(fileConfig.skills).toEqual({
      builtinRoot: "C:/tmp/builtin-skills",
      precedence: ["builtin", "local", "project", "team"],
      teamRoots: ["C:/tmp/team-skills"]
    });

    vi.stubEnv("AGENT_TEAM_SKILLS_HOME", "C:/tmp/team-skills-from-env");
    vi.stubEnv("AGENT_BUILTIN_SKILLS_ROOT", "C:/tmp/builtin-from-env");
    vi.stubEnv("AGENT_SKILLS_PRECEDENCE", "team,project,local,builtin");
    const envConfig = resolveRuntimeConfig(workspaceRoot);

    expect(envConfig.configSource).toBe("env");
    expect(envConfig.skills.builtinRoot).toBe("C:/tmp/builtin-from-env");
    expect(envConfig.skills.precedence).toEqual(["team", "project", "local", "builtin"]);
    expect(envConfig.skills.teamRoots).toEqual(["C:/tmp/team-skills-from-env"]);
  });
});

async function createTempWorkspace(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-runtime-config-"));
  tempPaths.push(workspaceRoot);
  return workspaceRoot;
}

function createMockDoctor(workspaceRoot: string): RuntimeDoctorService {
  const config = resolveRuntimeConfig(workspaceRoot);
  return new RuntimeDoctorService({
    allowedFetchHosts: config.allowedFetchHosts,
    customShell: config.workflow.customShell,
    databasePath: ":memory:",
    deprecatedCompactBufferTokens: config.compact.bufferTokens,
    listExperiences: () => [],
    maxShellTimeoutMs: config.workflow.maxShellTimeoutMs,
    providerConfig: {
      apiKey: null,
      baseUrl: null,
      builtinProviderName: "mock",
      configPath: join(workspaceRoot, ".auto-talon", "provider.config.json"),
      configSource: "defaults",
      contextWindowSource: null,
      contextWindowTokens: 64_000,
      displayName: "Mock",
      family: "mock",
      maxRetries: 0,
      model: "mock-model",
      name: "mock",
      streamIdleTimeoutMs: 30_000,
      timeoutMs: 30_000,
      transport: "mock"
    },
    providerName: "mock",
    runtimeConfigPath: join(workspaceRoot, ".auto-talon", "runtime.config.json"),
    runtimeConfigSource: "defaults",
    runtimeVersion: "test",
    shellBackend: config.workflow.shellBackend,
    skillStats: () => ({ issues: [], skills: [] }),
    testCommands: config.workflow.testCommands,
    testCurrentProvider: () =>
      Promise.resolve({
        apiKeyConfigured: true,
        endpointReachable: true,
        message: "ok",
        modelAvailable: true,
        modelConfigured: true,
        modelName: "mock-model",
        ok: true,
        providerName: "mock"
      }),
    tokenBudget: config.tokenBudget,
    workspaceRoot
  });
}
