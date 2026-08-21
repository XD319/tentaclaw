import { afterEach, describe, expect, it, vi } from "vitest";

import { AnthropicCompatibleProvider } from "../src/providers/anthropic-compatible-provider.js";
import {
  ANTHROPIC_CACHE_CONTROL_EPHEMERAL,
  ANTHROPIC_PROMPT_CACHING_BETA,
  anthropicRequestUsesPromptCache,
  buildAnthropicCompatibleRequestBody
} from "../src/providers/anthropic-request.js";
import { MEMORY_CONTEXT_SOURCE_TYPE } from "../src/core/prompt-prefix.js";
import type { ProviderInput } from "../src/types/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Anthropic cache_control breakpoints", () => {
  it("emits ephemeral breakpoints on tools, stable system, and memory prefix", () => {
    const body = buildAnthropicCompatibleRequestBody(createCachedProviderInput(), "claude-sonnet-4-20250514");

    expect(body.tools).toHaveLength(2);
    expect(body.tools?.[0]).not.toHaveProperty("cache_control");
    expect(body.tools?.[1]).toMatchObject({
      cache_control: ANTHROPIC_CACHE_CONTROL_EPHEMERAL,
      name: "write_file"
    });

    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system).toEqual([
      {
        cache_control: ANTHROPIC_CACHE_CONTROL_EPHEMERAL,
        text: "You are a coding agent.\n\nRepo map: src/app.ts",
        type: "text"
      },
      {
        cache_control: ANTHROPIC_CACHE_CONTROL_EPHEMERAL,
        text: "Recalled context: use pnpm",
        type: "text"
      },
      {
        text: "- [pending] 1: finish tests",
        type: "text"
      }
    ]);
    expect(anthropicRequestUsesPromptCache(body)).toBe(true);
  });

  it("keeps stream and non-stream bodies aligned except for stream=true", () => {
    const input = createCachedProviderInput();
    const complete = buildAnthropicCompatibleRequestBody(input, "claude-sonnet-4-20250514");
    const stream = buildAnthropicCompatibleRequestBody(input, "claude-sonnet-4-20250514", { stream: true });

    expect(stream.stream).toBe(true);
    expect(complete.stream).toBeUndefined();
    expect(stream.system).toEqual(complete.system);
    expect(stream.tools).toEqual(complete.tools);
    expect(stream.messages).toEqual(complete.messages);
  });

  it("treats untagged system messages as a stable prefix", () => {
    const body = buildAnthropicCompatibleRequestBody(
      {
        ...createCachedProviderInput(),
        availableTools: [],
        messages: [
          { content: "You are a helpful agent.", role: "system" },
          { content: "Read README.md", role: "user" }
        ]
      },
      "claude-sonnet-4-20250514"
    );

    expect(body.tools).toBeUndefined();
    expect(body.system).toEqual([
      {
        cache_control: ANTHROPIC_CACHE_CONTROL_EPHEMERAL,
        text: "You are a helpful agent.",
        type: "text"
      }
    ]);
  });
});

describe("Anthropic prompt-caching beta header constant", () => {
  it("uses the prompt-caching beta identifier", () => {
    expect(ANTHROPIC_PROMPT_CACHING_BETA).toBe("prompt-caching-2024-07-31");
  });
});

describe("Anthropic-compatible provider cache wiring", () => {
  it("sends cache_control and maps cache_read_input_tokens on complete and stream paths", async () => {
    const captured: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        const rawBody = init?.body;
        if (typeof rawBody !== "string") {
          throw new Error("Expected JSON request body.");
        }
        captured.push({
          body: JSON.parse(rawBody) as Record<string, unknown>,
          headers: new Headers(init?.headers)
        });
        const stream = (JSON.parse(rawBody) as { stream?: boolean }).stream === true;
        if (stream) {
          const encoder = new TextEncoder();
          return Promise.resolve(
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(
                    encoder.encode(
                      [
                        'data: {"type":"message_start","message":{"id":"msg-cache","model":"claude-sonnet-4-20250514","usage":{"input_tokens":20,"output_tokens":0,"cache_read_input_tokens":12}}}',
                        "",
                        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
                        "",
                        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
                        "",
                        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
                        ""
                      ].join("\n")
                    )
                  );
                  controller.close();
                }
              }),
              { status: 200 }
            )
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              content: [{ text: "ok", type: "text" }],
              id: "msg-cache",
              model: "claude-sonnet-4-20250514",
              stop_reason: "end_turn",
              type: "message",
              usage: {
                cache_read_input_tokens: 12,
                input_tokens: 20,
                output_tokens: 1
              }
            }),
            { status: 200 }
          )
        );
      })
    );

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

    const complete = await provider.generate(createCachedProviderInput());
    expect(complete.usage.cachedInputTokens).toBe(12);
    expect(captured[0]?.headers.get("anthropic-beta")).toBe(ANTHROPIC_PROMPT_CACHING_BETA);
    expect(JSON.stringify(captured[0]?.body.tools)).toContain("cache_control");
    expect(JSON.stringify(captured[0]?.body.system)).toContain("cache_control");

    const streamInput = createCachedProviderInput();
    streamInput.onTextDelta = () => undefined;
    const streamed = await provider.generate(streamInput);
    expect(streamed.usage.cachedInputTokens).toBe(12);
    expect(captured[1]?.headers.get("anthropic-beta")).toBe(ANTHROPIC_PROMPT_CACHING_BETA);
    expect(captured[1]?.body.stream).toBe(true);
  });
});

function createCachedProviderInput(): ProviderInput {
  return {
    agentProfileId: "executor",
    availableTools: [
      {
        capability: "filesystem.read",
        description: "Read files",
        inputSchema: { type: "object" },
        name: "read_file",
        privacyLevel: "internal",
        riskLevel: "low"
      },
      {
        capability: "filesystem.write",
        description: "Write files",
        inputSchema: { type: "object" },
        name: "write_file",
        privacyLevel: "internal",
        riskLevel: "medium"
      }
    ],
    iteration: 1,
    memoryContext: [],
    messages: [
      {
        content: "You are a coding agent.",
        metadata: { privacyLevel: "internal", retentionKind: "working", sourceType: "system_prompt" },
        role: "system"
      },
      {
        content: "- [pending] 1: finish tests",
        metadata: { privacyLevel: "internal", retentionKind: "session", sourceType: "session_todos" },
        role: "system"
      },
      {
        content: "Repo map: src/app.ts",
        metadata: { privacyLevel: "internal", retentionKind: "working", sourceType: "system_prompt" },
        role: "system"
      },
      {
        content: "Recalled context: use pnpm",
        metadata: { privacyLevel: "internal", retentionKind: "working", sourceType: MEMORY_CONTEXT_SOURCE_TYPE },
        role: "system"
      },
      {
        content: "implement slugify",
        role: "user"
      }
    ],
    signal: new AbortController().signal,
    task: {
      agentProfileId: "executor",
      createdAt: "2026-01-01T00:00:00.000Z",
      currentIteration: 0,
      cwd: "/tmp",
      errorCode: null,
      errorMessage: null,
      finalOutput: null,
      finishedAt: null,
      input: "implement slugify",
      maxIterations: 4,
      metadata: {},
      providerName: "anthropic",
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
      updatedAt: "2026-01-01T00:00:00.000Z"
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
