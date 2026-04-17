import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GlmProvider,
  ManagedProvider,
  MockProvider,
  ProviderError,
  classifyProviderHttpError
} from "../src/providers";
import type { Provider, ProviderConfig, ProviderInput, ProviderResponse } from "../src/types";

interface ProviderContractHarness {
  createAuthErrorProvider(): Provider;
  createEmptyProvider(): Provider;
  createMalformedResponseProvider(): Provider;
  createNetworkFailureProvider(maxRetries?: number): Provider;
  createRateLimitProvider(maxRetries?: number): Provider;
  createTextProvider(): Provider;
  createTimeoutProvider(maxRetries?: number): Provider;
  createToolCallProvider(): Provider;
  createUnavailableProvider(maxRetries?: number): Provider;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Provider contract tests", () => {
  runProviderContractSuite("mock provider", createMockHarness());
  runProviderContractSuite("glm provider mapping", createGlmHarness());
});

describe("Provider runtime safeguards", () => {
  it("classifies provider HTTP errors into the unified taxonomy", () => {
    expect(classifyProviderHttpError(401, "authentication_error")).toBe("auth_error");
    expect(classifyProviderHttpError(429, "rate_limit")).toBe("rate_limit");
    expect(classifyProviderHttpError(408, "timeout")).toBe("timeout_error");
    expect(classifyProviderHttpError(503, "service_unavailable")).toBe("provider_unavailable");
    expect(classifyProviderHttpError(501, "unsupported_feature")).toBe("unsupported_capability");
    expect(classifyProviderHttpError(400, "invalid_request_error")).toBe("invalid_request");
  });

  it("retries retriable provider errors", async () => {
    let attempts = 0;
    const provider = new ManagedProvider(
      new MockProvider({}, () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("socket reset");
        }

        return finalResponse("recovered");
      }),
      {
        maxRetries: 2
      } as Pick<ProviderConfig, "maxRetries">
    );

    const response = await provider.generate(createProviderInput("recover"));

    expect(response.kind).toBe("final");
    expect(response.metadata?.retryCount).toBe(2);
    expect(attempts).toBe(3);
  });

  it("does not retry non-retriable provider errors", async () => {
    let attempts = 0;
    const provider = new ManagedProvider(
      new MockProvider({}, () => {
        attempts += 1;
        throw new ProviderError({
          category: "auth_error",
          message: "bad key",
          providerName: "mock",
          retriable: false,
          summary: "Authentication failed."
        });
      }),
      {
        maxRetries: 3
      } as Pick<ProviderConfig, "maxRetries">
    );

    await expect(provider.generate(createProviderInput("fail"))).rejects.toMatchObject({
      category: "auth_error",
      retryCount: 0
    });
    expect(attempts).toBe(1);
  });

  it("recognizes malformed provider responses", async () => {
    const provider = new ManagedProvider(
      new MockProvider({}, () => ({ usage: { inputTokens: 1, outputTokens: 1 } } as ProviderResponse)),
      {
        maxRetries: 0
      } as Pick<ProviderConfig, "maxRetries">
    );

    await expect(provider.generate(createProviderInput("malformed"))).rejects.toMatchObject({
      category: "malformed_response"
    });
  });
});

function runProviderContractSuite(name: string, harness: ProviderContractHarness): void {
  describe(name, () => {
    it("handles standard text generation", async () => {
      const response = await harness.createTextProvider().generate(createProviderInput("summarize"));
      expect(response.kind).toBe("final");
      expect(response.message.length).toBeGreaterThanOrEqual(0);
    });

    it("handles tool call responses", async () => {
      const response = await harness
        .createToolCallProvider()
        .generate(createProviderInput("read README.md"));

      expect(response.kind).toBe("tool_calls");
      if (response.kind !== "tool_calls") {
        throw new Error("Expected tool call response.");
      }

      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls[0]?.toolName).toBe("file_read");
    });

    it("accepts empty responses", async () => {
      const response = await harness.createEmptyProvider().generate(createProviderInput("empty"));
      expect(response.kind).toBe("final");
      expect(response.message).toBe("");
    });

    it("rejects malformed response structures", async () => {
      await expect(
        harness.createMalformedResponseProvider().generate(createProviderInput("malformed"))
      ).rejects.toMatchObject({
        category: "malformed_response"
      });
    });

    it("maps transient network failures", async () => {
      await expect(
        harness.createNetworkFailureProvider(0).generate(createProviderInput("network"))
      ).rejects.toMatchObject({
        category: "transient_network_error"
      });
    });

    it("maps timeout failures", async () => {
      await expect(
        harness.createTimeoutProvider(0).generate(createProviderInput("timeout"))
      ).rejects.toMatchObject({
        category: "timeout_error"
      });
    });

    it("maps rate limit failures", async () => {
      await expect(
        harness.createRateLimitProvider(0).generate(createProviderInput("rate"))
      ).rejects.toMatchObject({
        category: "rate_limit"
      });
    });

    it("maps auth failures", async () => {
      await expect(
        harness.createAuthErrorProvider().generate(createProviderInput("auth"))
      ).rejects.toMatchObject({
        category: "auth_error"
      });
    });

    it("maps provider unavailable failures", async () => {
      await expect(
        harness.createUnavailableProvider(0).generate(createProviderInput("unavailable"))
      ).rejects.toMatchObject({
        category: "provider_unavailable"
      });
    });
  });
}

function createMockHarness(): ProviderContractHarness {
  return {
    createAuthErrorProvider: () =>
      managedMock(() => {
        throw providerError("auth_error", "bad key", false);
      }),
    createEmptyProvider: () => managedMock(() => finalResponse("")),
    createMalformedResponseProvider: () =>
      managedMock(() => ({ kind: "final", usage: { inputTokens: 1, outputTokens: 1 } } as ProviderResponse)),
    createNetworkFailureProvider: (maxRetries = 0) =>
      managedMock(() => {
        throw new Error("socket closed");
      }, maxRetries),
    createRateLimitProvider: (maxRetries = 0) =>
      managedMock(() => {
        throw providerError("rate_limit", "slow down", true);
      }, maxRetries),
    createTextProvider: () => managedMockProvider(new MockProvider()),
    createTimeoutProvider: (maxRetries = 0) =>
      managedMock(() => {
        throw new DOMException("timeout", "AbortError");
      }, maxRetries),
    createToolCallProvider: () => managedMockProvider(new MockProvider()),
    createUnavailableProvider: (maxRetries = 0) =>
      managedMock(() => {
        throw providerError("provider_unavailable", "service down", true);
      }, maxRetries)
  };
}

function createGlmHarness(): ProviderContractHarness {
  return {
    createAuthErrorProvider: () =>
      managedGlm(jsonResponse({
        error: {
          message: "invalid api key",
          type: "authentication_error"
        }
      }, 401)),
    createEmptyProvider: () =>
      managedGlm(jsonResponse({
        choices: [
          {
            index: 0,
            message: {
              content: "",
              role: "assistant"
            }
          }
        ],
        usage: {
          completion_tokens: 0,
          prompt_tokens: 1,
          total_tokens: 1
        }
      })),
    createMalformedResponseProvider: () =>
      managedGlm(jsonResponse({
        choices: [
          {
            finish_reason: "tool_calls",
            index: 0,
            message: {
              content: "Need a tool.",
              role: "assistant",
              tool_calls: [
                {
                  function: {
                    arguments: "{bad json",
                    name: "file_read"
                  },
                  id: "call-1",
                  type: "function"
                }
              ]
            }
          }
        ],
        usage: {
          completion_tokens: 0,
          prompt_tokens: 1,
          total_tokens: 1
        }
      })),
    createNetworkFailureProvider: (maxRetries = 0) =>
      managedGlm(async () => {
        throw new Error("socket hang up");
      }, maxRetries),
    createRateLimitProvider: (maxRetries = 0) =>
      managedGlm(jsonResponse({
        error: {
          message: "too many requests",
          type: "rate_limit_error"
        }
      }, 429), maxRetries),
    createTextProvider: () =>
      managedGlm(jsonResponse({
        choices: [
          {
            finish_reason: "stop",
            index: 0,
            message: {
              content: "glm text",
              role: "assistant"
            }
          }
        ],
        model: "glm-4.5-air",
        usage: {
          completion_tokens: 2,
          prompt_tokens: 3,
          total_tokens: 5
        }
      })),
    createTimeoutProvider: (maxRetries = 0) =>
      managedGlm(async () => {
        throw new DOMException("timeout", "AbortError");
      }, maxRetries),
    createToolCallProvider: () =>
      managedGlm(jsonResponse({
        choices: [
          {
            finish_reason: "tool_calls",
            index: 0,
            message: {
              content: "Need a tool.",
              role: "assistant",
              tool_calls: [
                {
                  function: {
                    arguments: "{\"path\":\"README.md\",\"action\":\"read_file\"}",
                    name: "file_read"
                  },
                  id: "call-1",
                  type: "function"
                }
              ]
            }
          }
        ],
        model: "glm-4.5-air",
        usage: {
          completion_tokens: 2,
          prompt_tokens: 3,
          total_tokens: 5
        }
      })),
    createUnavailableProvider: (maxRetries = 0) =>
      managedGlm(jsonResponse({
        error: {
          message: "service unavailable",
          type: "service_unavailable"
        }
      }, 503), maxRetries)
  };
}

function managedMock(
  responder: (input: ProviderInput) => Promise<ProviderResponse> | ProviderResponse,
  maxRetries = 0
): Provider {
  return managedMockProvider(new MockProvider({}, responder), maxRetries);
}

function managedMockProvider(provider: Provider, maxRetries = 0): Provider {
  return new ManagedProvider(provider, { maxRetries } as Pick<ProviderConfig, "maxRetries">);
}

function managedGlm(
  fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | Response,
  maxRetries = 0
): Provider {
  const implementation =
    fetchImpl instanceof Response ? vi.fn(async () => fetchImpl.clone()) : vi.fn(fetchImpl);
  vi.stubGlobal("fetch", implementation);

  return new ManagedProvider(
    new GlmProvider({
      apiKey: "glm-test-key",
      baseUrl: "https://glm.example.test/v4",
      maxRetries: 0,
      model: "glm-4.5-air",
      name: "glm",
      timeoutMs: 5_000
    }),
    { maxRetries } as Pick<ProviderConfig, "maxRetries">
  );
}

function createProviderInput(taskInput: string): ProviderInput {
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
        content: taskInput,
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
      input: taskInput,
      maxIterations: 4,
      metadata: {},
      providerName: "mock",
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

function finalResponse(message: string): ProviderResponse {
  return {
    kind: "final",
    message,
    usage: {
      inputTokens: 1,
      outputTokens: 1
    }
  };
}

function providerError(
  category: ProviderError["category"],
  message: string,
  retriable: boolean
): ProviderError {
  return new ProviderError({
    category,
    message,
    providerName: "mock",
    retriable,
    summary: message
  });
}

function jsonResponse(payload: object, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json"
    },
    status
  });
}
