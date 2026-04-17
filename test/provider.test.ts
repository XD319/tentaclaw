import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApplication, createDefaultRunOptions } from "../src/runtime";
import { GlmProvider, ProviderError, resolveProviderConfig } from "../src/providers";
import type {
  Provider,
  ProviderConfig,
  ProviderHealthCheck,
  ProviderInput,
  ProviderResponse
} from "../src/types";

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
    await fs.mkdir(join(workspaceRoot, ".tentaclaw"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".tentaclaw", "provider.config.json"),
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
          apiKey: "glm-test-key",
          baseUrl: `http://127.0.0.1:${address.port}/v4`,
          configPath: join(workspaceRoot, ".tentaclaw", "provider.config.json"),
          configSource: "env",
          maxRetries: 1,
          model: "glm-4.5-air",
          name: "glm",
          timeoutMs: 5_000
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
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "tentaclaw-provider-"));
  tempPaths.push(workspaceRoot);
  return workspaceRoot;
}
