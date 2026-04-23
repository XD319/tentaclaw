import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApplication, createDefaultRunOptions } from "../src/runtime/index.js";
import {
  AnthropicCompatibleProvider,
  createProvider,
  GlmProvider,
  OpenAiCompatibleProvider,
  ProviderError,
  resolveProviderCatalog,
  resolveProviderConfig
} from "../src/providers/index.js";
import type {
  Provider,
  ProviderConfig,
  ProviderHealthCheck,
  ProviderInput,
  ProviderResponse
} from "../src/types/index.js";

class ScriptedProvider implements Provider {
  public readonly name = "scripted-provider";

  public constructor(
    private readonly responder: (input: ProviderInput) => Promise<ProviderResponse> | ProviderResponse,
    public readonly model = "scripted-model"
  ) {}

  public async generate(input: ProviderInput): Promise<ProviderResponse> {
    return this.responder(input);
  }

  public testConnection(): Promise<ProviderHealthCheck> {
    return Promise.resolve({
      apiKeyConfigured: true,
      endpointReachable: true,
      message: "scripted provider reachable",
      modelAvailable: true,
      modelConfigured: true,
      modelName: this.model,
      ok: true,
      providerName: this.name
    });
  }
}

const tempPaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();

  delete process.env.AGENT_PROVIDER;
  delete process.env.AGENT_PROVIDER_API_KEY;
  delete process.env.AGENT_PROVIDER_BASE_URL;
  delete process.env.AGENT_PROVIDER_MODEL;
  delete process.env.AGENT_PROVIDER_TIMEOUT_MS;
  delete process.env.AGENT_PROVIDER_MAX_RETRIES;

  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined) {
      await fs.rm(tempPath, { force: true, recursive: true });
    }
  }
});

describe("Provider integration", () => {
  it("keeps MockProvider configurable and runnable", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.writeFile(join(workspaceRoot, "README.md"), "provider test", "utf8");
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      }
    });

    try {
      const result = await handle.service.runTask(
        createDefaultRunOptions("read README.md", workspaceRoot, handle.config)
      );

      expect(handle.service.currentProvider().name).toBe("mock");
      expect(result.task.status).toBe("succeeded");
      expect(result.output).toContain("Task completed from tool feedback.");
    } finally {
      handle.close();
    }
  });

  it("loads GLM provider configuration from file", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "provider.config.json"),
      JSON.stringify(
        {
          currentProvider: "glm",
          providers: {
            glm: {
              apiKey: "glm-test-key",
              baseUrl: "https://glm.example.test/v4",
              maxRetries: 4,
              model: "glm-4.5-air",
              timeoutMs: 12_000
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const resolved = resolveProviderConfig(workspaceRoot);

    expect(resolved.name).toBe("glm");
    expect(resolved.apiKey).toBe("glm-test-key");
    expect(resolved.baseUrl).toBe("https://glm.example.test/v4");
    expect(resolved.model).toBe("glm-4.5-air");
    expect(resolved.timeoutMs).toBe(12_000);
    expect(resolved.maxRetries).toBe(4);
    expect(resolved.configSource).toBe("file");
  });

  it("loads OpenAI-compatible provider configuration from file aliases", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "provider.config.json"),
      JSON.stringify(
        {
          currentProvider: "openai-compatible",
          providers: {
            "openai-compatible": {
              apiKey: "compat-test-key",
              baseUrl: "https://compat.example.test/v1",
              maxRetries: 3,
              model: "kimi-k2",
              timeoutMs: 15_000
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const resolved = resolveProviderConfig(workspaceRoot);

    expect(resolved.name).toBe("openai-compatible");
    expect(resolved.apiKey).toBe("compat-test-key");
    expect(resolved.baseUrl).toBe("https://compat.example.test/v1");
    expect(resolved.model).toBe("kimi-k2");
    expect(resolved.timeoutMs).toBe(15_000);
    expect(resolved.maxRetries).toBe(3);
  });

  it("loads iFLYTEK Coding Plan provider configuration from file", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "provider.config.json"),
      JSON.stringify(
        {
          currentProvider: "xfyun-coding",
          providers: {
            "xfyun-coding": {
              apiKey: "xfyun-test-key",
              maxRetries: 5,
              timeoutMs: 18_000
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const resolved = resolveProviderConfig(workspaceRoot);

    expect(resolved.name).toBe("xfyun-coding");
    expect(resolved.apiKey).toBe("xfyun-test-key");
    expect(resolved.baseUrl).toBe("https://maas-coding-api.cn-huabei-1.xf-yun.com/v2");
    expect(resolved.model).toBe("astron-code-latest");
    expect(resolved.displayName).toBe("iFLYTEK Coding Plan");
    expect(resolved.family).toBe("openai-compatible");
    expect(resolved.transport).toBe("openai-compatible");
    expect(resolved.timeoutMs).toBe(18_000);
    expect(resolved.maxRetries).toBe(5);
    expect(createProvider(resolved).capabilities?.streaming).toBe(false);
  });

  it("loads custom OpenAI-compatible providers from config without code changes", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "provider.config.json"),
      JSON.stringify(
        {
          currentProvider: "vendor-coding",
          customProviders: {
            "vendor-coding": {
              apiKey: "vendor-test-key",
              baseUrl: "https://vendor.example.test/v1",
              displayName: "Vendor Coding",
              model: "vendor-code-latest",
              providerLabel: "Vendor Coding",
              timeoutMs: 16_000,
              transport: "openai-compatible"
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const resolved = resolveProviderConfig(workspaceRoot);

    expect(resolved.name).toBe("vendor-coding");
    expect(resolved.builtinProviderName).toBeNull();
    expect(resolved.apiKey).toBe("vendor-test-key");
    expect(resolved.baseUrl).toBe("https://vendor.example.test/v1");
    expect(resolved.model).toBe("vendor-code-latest");
    expect(resolved.displayName).toBe("Vendor Coding");
    expect(resolved.transport).toBe("openai-compatible");
    expect(resolved.timeoutMs).toBe(16_000);
  });

  it("loads Anthropic provider configuration from provider/model selectors", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "provider.config.json"),
      JSON.stringify(
        {
          currentProvider: "claude/claude-sonnet-4-20250514",
          providers: {
            claude: {
              apiKey: "anthropic-test-key",
              timeoutMs: 14_000
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const resolved = resolveProviderConfig(workspaceRoot);

    expect(resolved.name).toBe("anthropic");
    expect(resolved.apiKey).toBe("anthropic-test-key");
    expect(resolved.baseUrl).toBe("https://api.anthropic.com");
    expect(resolved.model).toBe("claude-sonnet-4-20250514");
    expect(resolved.displayName).toBe("Anthropic");
    expect(resolved.family).toBe("anthropic-compatible");
    expect(resolved.transport).toBe("anthropic-compatible");
    expect(resolved.timeoutMs).toBe(14_000);
  });

  it("resolves provider aliases and provider/model references from config", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "provider.config.json"),
      JSON.stringify(
        {
          currentProvider: "z.ai/glm-4.5-air",
          providers: {
            "zhipu": {
              apiKey: "glm-test-key",
              timeoutMs: 9_000
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const resolved = resolveProviderConfig(workspaceRoot);

    expect(resolved.name).toBe("glm");
    expect(resolved.model).toBe("glm-4.5-air");
    expect(resolved.apiKey).toBe("glm-test-key");
    expect(resolved.displayName).toBe("GLM");
    expect(resolved.family).toBe("openai-compatible");
    expect(resolved.transport).toBe("openai-compatible");
    expect(resolved.timeoutMs).toBe(9_000);
  });

  it("includes the first-batch and second-batch providers in the catalog", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      }
    });

    try {
      const providerNames = handle.service.listProviders().map((provider) => provider.name);
      expect(providerNames).toEqual(
        expect.arrayContaining([
          "openai",
          "anthropic",
          "xfyun-coding",
          "gemini",
          "openrouter",
          "ollama",
          "glm",
          "moonshot",
          "minimax",
          "qwen",
          "xai"
        ])
      );
    } finally {
      handle.close();
    }
  });

  it("includes configured custom providers in the catalog", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "provider.config.json"),
      JSON.stringify(
        {
          customProviders: {
            "vendor-coding": {
              baseUrl: "https://vendor.example.test/v1",
              displayName: "Vendor Coding",
              model: "vendor-code-latest",
              transport: "openai-compatible"
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const catalog = resolveProviderCatalog(workspaceRoot);

    expect(catalog.some((provider) => provider.name === "vendor-coding")).toBe(true);
  });

  it("maps GLM tool calls into the unified provider response shape", async () => {
    const provider = new GlmProvider(createGlmConfig({
      apiKey: "glm-test-key",
      baseUrl: "https://glm.example.test/v4"
    }));

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                index: 0,
                message: {
                  content: "Need file access.",
                  role: "assistant",
                  tool_calls: [
                    {
                      function: {
                        arguments: "{\"action\":\"read_file\",\"path\":\"README.md\"}",
                        name: "file_read"
                      },
                      id: "call-1",
                      type: "function"
                    }
                  ]
                }
              }
            ],
            id: "resp-1",
            model: "glm-4.5-air",
            usage: {
              completion_tokens: 11,
              prompt_tokens: 22,
              total_tokens: 33
            }
          }),
          {
            status: 200
          }
        )
      )
    );

    const response = await provider.generate(createProviderInput());

    expect(response.kind).toBe("tool_calls");
    if (response.kind !== "tool_calls") {
      throw new Error("Expected tool call response.");
    }

    expect(response.toolCalls[0]).toEqual({
      input: {
        action: "read_file",
        path: "README.md"
      },
      raw: {
        arguments: "{\"action\":\"read_file\",\"path\":\"README.md\"}",
        index: 0
      },
      reason: "Provider file_read tool call requested.",
      toolCallId: "call-1",
      toolName: "file_read"
    });
    expect(response.metadata?.providerName).toBe("glm");
    expect(response.metadata?.modelName).toBe("glm-4.5-air");
    expect(response.usage.totalTokens).toBe(33);
  });

  it("maps OpenAI-compatible responses into the unified provider response shape", async () => {
    const provider = new OpenAiCompatibleProvider(
      {
        apiKey: "compat-test-key",
        baseUrl: "https://compat.example.test/v1",
        maxRetries: 0,
        model: "kimi-k2",
        name: "openai-compatible",
        timeoutMs: 5_000
      },
      {
        defaultBaseUrl: null,
        defaultDisplayName: "OpenAI Compatible",
        defaultModel: "gpt-4o-mini"
      }
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                index: 0,
                message: {
                  content: "compatible text",
                  role: "assistant"
                }
              }
            ],
            id: "resp-compat-1",
            model: "kimi-k2",
            usage: {
              completion_tokens: 9,
              prompt_tokens: 12,
              total_tokens: 21
            }
          }),
          {
            status: 200
          }
        )
      )
    );

    const response = await provider.generate(createProviderInput());

    expect(response.kind).toBe("final");
    expect(response.message).toBe("compatible text");
    expect(response.metadata?.providerName).toBe("openai-compatible");
    expect(response.metadata?.modelName).toBe("kimi-k2");
  });

  it("uses non-streaming requests when OpenAI-compatible streaming is disabled", async () => {
    const provider = new OpenAiCompatibleProvider(
      {
        apiKey: "compat-test-key",
        baseUrl: "https://compat.example.test/v1",
        maxRetries: 0,
        model: "kimi-k2",
        name: "openai-compatible",
        timeoutMs: 5_000
      },
      {
        defaultBaseUrl: null,
        defaultDisplayName: "OpenAI Compatible",
        defaultModel: "gpt-4o-mini",
        supportsStreaming: false
      }
    );
    let streamed = "";

    vi.stubGlobal(
      "fetch",
      vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        expect(typeof init?.body).toBe("string");
        const body = JSON.parse(init?.body as string) as { stream?: boolean };
        expect(body.stream).toBe(false);
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                index: 0,
                message: {
                  content: "non-streamed text",
                  role: "assistant"
                }
              }
            ],
            id: "resp-non-streamed",
            model: "kimi-k2",
            usage: {
              completion_tokens: 3,
              prompt_tokens: 7,
              total_tokens: 10
            }
          }),
          {
            status: 200
          }
        );
      })
    );

    const response = await provider.generate({
      ...createProviderInput(),
      onTextDelta: (delta) => {
        streamed += delta;
      }
    });

    expect(response.kind).toBe("final");
    expect(response.message).toBe("non-streamed text");
    expect(streamed).toBe("");
  });

  it("parses a final OpenAI-compatible stream event without a trailing newline", async () => {
    const provider = new OpenAiCompatibleProvider(
      {
        apiKey: "compat-test-key",
        baseUrl: "https://compat.example.test/v1",
        maxRetries: 0,
        model: "kimi-k2",
        name: "openai-compatible",
        timeoutMs: 5_000
      },
      {
        defaultBaseUrl: null,
        defaultDisplayName: "OpenAI Compatible",
        defaultModel: "gpt-4o-mini"
      }
    );
    let streamed = "";

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        new Response(
          [
            'data: {"choices":[{"index":0,"delta":{"content":"hel"}}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
            'data: {"choices":[{"index":0,"delta":{"content":"lo"}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
            "data: [DONE]"
          ].join(""),
          {
            headers: {
              "Content-Type": "text/event-stream"
            },
            status: 200
          }
        )
      )
    );

    const response = await provider.generate({
      ...createProviderInput(),
      onTextDelta: (delta) => {
        streamed += delta;
      }
    });

    expect(response.kind).toBe("final");
    expect(response.message).toBe("hello");
    expect(response.usage.totalTokens).toBe(5);
    expect(streamed).toBe("hello");
  });

  it("maps Anthropic-compatible responses into the unified provider response shape", async () => {
    const provider = new AnthropicCompatibleProvider(
      {
        apiKey: "anthropic-test-key",
        baseUrl: "https://anthropic.example.test",
        maxRetries: 0,
        model: "claude-sonnet-4-20250514",
        name: "anthropic",
        timeoutMs: 5_000
      },
      {
        anthropicVersion: "2023-06-01",
        defaultBaseUrl: "https://api.anthropic.com",
        defaultDisplayName: "Anthropic",
        defaultModel: "claude-sonnet-4-20250514"
      }
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        new Response(
          JSON.stringify({
            content: [
              {
                text: "Need a tool.",
                type: "text"
              },
              {
                id: "call-1",
                input: {
                  action: "read_file",
                  path: "README.md"
                },
                name: "file_read",
                type: "tool_use"
              }
            ],
            id: "msg-1",
            model: "claude-sonnet-4-20250514",
            stop_reason: "tool_use",
            type: "message",
            usage: {
              input_tokens: 10,
              output_tokens: 4
            }
          }),
          {
            status: 200
          }
        )
      )
    );

    const response = await provider.generate(createProviderInput());

    expect(response.kind).toBe("tool_calls");
    if (response.kind !== "tool_calls") {
      throw new Error("Expected tool call response.");
    }

    expect(response.message).toBe("Need a tool.");
    expect(response.toolCalls[0]).toEqual({
      input: {
        action: "read_file",
        path: "README.md"
      },
      raw: {
        index: 1
      },
      reason: "Provider file_read tool call requested.",
      toolCallId: "call-1",
      toolName: "file_read"
    });
    expect(response.metadata?.providerName).toBe("anthropic");
    expect(response.metadata?.modelName).toBe("claude-sonnet-4-20250514");
    expect(response.usage.totalTokens).toBe(14);
  });

  it("maps provider failures into unified provider errors", async () => {
    const provider = new GlmProvider(createGlmConfig({
      apiKey: "glm-test-key",
      baseUrl: "https://glm.example.test/v4"
    }));

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        new Response(
          JSON.stringify({
            error: {
              message: "invalid api key",
              type: "authentication_error"
            }
          }),
          {
            status: 401
          }
        )
      )
    );

    await expect(provider.generate(createProviderInput())).rejects.toMatchObject({
      category: "auth_error",
      providerName: "glm"
    } satisfies Partial<ProviderError>);
  });

  it("reports provider test and doctor diagnostics", async () => {
    const workspaceRoot = await createTempWorkspace();
    const server = createServer((request, response) => {
      if (request.url === "/v4/models") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "glm-4.5-air" }] }));
        return;
      }

      response.writeHead(404).end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("Expected a TCP server address.");
    }

    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db"),
        provider: {
          builtinProviderName: "glm",
          apiKey: "glm-test-key",
          baseUrl: `http://127.0.0.1:${address.port}/v4`,
          configPath: join(workspaceRoot, ".auto-talon", "provider.config.json"),
          configSource: "env",
          displayName: "GLM",
          family: "openai-compatible",
          maxRetries: 1,
          model: "glm-4.5-air",
          name: "glm",
          timeoutMs: 5_000,
          transport: "openai-compatible"
        }
      }
    });

    try {
      const testReport = await handle.service.testCurrentProvider();
      const doctorReport = await handle.service.configDoctor();

      expect(testReport.ok).toBe(true);
      expect(testReport.endpointReachable).toBe(true);
      expect(testReport.modelAvailable).toBe(true);
      expect(doctorReport.apiKeyConfigured).toBe(true);
      expect(doctorReport.endpointReachable).toBe(true);
      expect(doctorReport.modelConfigured).toBe(true);
      expect(doctorReport.issues).toEqual([]);
    } finally {
      handle.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined && error !== null) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  });

  it("records provider trace events and unified provider errors at runtime", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      },
      provider: new ScriptedProvider((input) => {
        if (input.task.input === "fail provider") {
          throw new ProviderError({
            category: "rate_limit",
            message: "provider throttled",
            modelName: "scripted-model",
            providerName: "scripted-provider",
            retriable: true,
            summary: "provider throttled"
          });
        }

        return {
          kind: "final",
          message: "provider success",
          metadata: {
            modelName: "scripted-model",
            providerName: "scripted-provider",
            retryCount: 1
          },
          usage: {
            inputTokens: 12,
            outputTokens: 6,
            totalTokens: 18
          }
        };
      })
    });

    try {
      const succeeded = await handle.service.runTask(
        createDefaultRunOptions("provider success", workspaceRoot, handle.config)
      );
      const failed = await handle.service.runTask(
        createDefaultRunOptions("fail provider", workspaceRoot, handle.config)
      );

      const successTrace = handle.service.traceTask(succeeded.task.taskId);
      const failedTrace = handle.service.traceTask(failed.task.taskId);

      expect(
        successTrace.some((event) => event.eventType === "provider_request_started")
      ).toBe(true);
      expect(
        successTrace.some(
          (event) =>
            event.eventType === "provider_request_succeeded" &&
            event.payload.providerName === "scripted-provider"
        )
      ).toBe(true);
      expect(
        failedTrace.some(
          (event) =>
            event.eventType === "provider_request_failed" &&
            event.payload.errorCategory === "rate_limit" &&
            event.payload.retryCount === 0
        )
      ).toBe(true);
      expect(failed.error?.code).toBe("provider_error");
      expect(failed.error?.details?.providerCategory).toBe("rate_limit");
      expect(handle.service.providerStats()?.failedRequests).toBe(1);
      expect(handle.service.providerStats()?.successfulRequests).toBe(1);
    } finally {
      handle.close();
    }
  });
});

function createProviderInput(): ProviderInput {
  return {
    agentProfileId: "executor",
    availableTools: [
      {
        capability: "filesystem.read",
        description: "Read files from the workspace.",
        inputSchema: {
          properties: {
            action: {
              enum: ["read_file"],
              type: "string"
            },
            path: {
              type: "string"
            }
          },
          required: ["action", "path"],
          type: "object"
        },
        name: "file_read",
        privacyLevel: "internal",
        riskLevel: "low"
      }
    ],
    iteration: 1,
    memoryContext: [],
    messages: [
      {
        content: "You are a helpful agent.",
        role: "system"
      },
      {
        content: "Read the README file.",
        role: "user"
      }
    ],
    signal: new AbortController().signal,
    task: {
      agentProfileId: "executor",
      createdAt: new Date().toISOString(),
      currentIteration: 0,
      cwd: "D:\\workspace",
      errorCode: null,
      errorMessage: null,
      finalOutput: null,
      finishedAt: null,
      input: "Read the README file.",
      maxIterations: 4,
      metadata: {},
      providerName: "glm",
      requesterUserId: "tester",
      startedAt: null,
      status: "running",
      taskId: "task-1",
      tokenBudget: {
        inputLimit: 8_000,
        outputLimit: 2_000,
        reservedOutput: 500,
        usedInput: 0,
        usedOutput: 0
      },
      updatedAt: new Date().toISOString()
    },
    tokenBudget: {
      inputLimit: 8_000,
      outputLimit: 2_000,
      reservedOutput: 500,
      usedInput: 0,
      usedOutput: 0
    }
  };
}

function createGlmConfig(
  overrides: Partial<ProviderConfig>
): ProviderConfig {
  return {
    apiKey: "glm-test-key",
    baseUrl: "https://glm.example.test/v4",
    maxRetries: 0,
    model: "glm-4.5-air",
    name: "glm",
    timeoutMs: 5_000,
    ...overrides
  };
}

async function createTempWorkspace(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-provider-"));
  tempPaths.push(workspaceRoot);
  return workspaceRoot;
}
