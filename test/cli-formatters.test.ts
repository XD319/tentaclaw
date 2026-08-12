import { describe, expect, it } from "vitest";

import { formatApprovalList, formatCurrentProvider, formatProviderHealth } from "../src/cli/formatters.js";
import {
  formatProviderSetupNextSteps,
  missingApiKeyMessage
} from "../src/providers/provider-setup-guidance.js";

describe("cli formatters", () => {
  it("formats invalid approval expiry as unknown", () => {
    const output = formatApprovalList([
      {
        approvalId: "approval-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "not-a-date",
        reason: "test approval",
        reviewerId: null,
        status: "pending",
        taskId: "task-1",
        toolCallId: "tool-1",
        toolName: "shell"
      }
    ]);

    expect(output).toContain("expires=unknown");
  });

  it("explains next steps when provider status is unconfigured", () => {
    const output = formatCurrentProvider({
      baseUrl: null,
      builtinProviderName: null,
      configPath: "/tmp/provider.config.json",
      configSource: "defaults",
      configured: false,
      contextWindowTokens: null,
      maxRetries: 2,
      model: null,
      name: "unconfigured",
      streamIdleTimeoutMs: 120_000,
      timeoutMs: 120_000,
      transport: "openai-compatible"
    });

    expect(output).toContain("Setup Required: yes");
    expect(output).toContain("talon provider setup mock");
    expect(output).toContain("talon provider setup <provider> --api-key <key>");
  });

  it("explains next steps when context window is unknown", () => {
    const output = formatCurrentProvider({
      baseUrl: "https://api.openai.com/v1",
      builtinProviderName: "openai",
      configPath: "/tmp/provider.config.json",
      configSource: "user",
      configured: true,
      contextWindowTokens: null,
      maxRetries: 2,
      model: "gpt-4o-mini",
      name: "openai",
      streamIdleTimeoutMs: 120_000,
      timeoutMs: 120_000,
      transport: "openai-compatible"
    });

    expect(output).toContain("context window is unknown");
    expect(output).toContain("--context-window-tokens");
  });

  it("explains next steps when provider test is missing an API key", () => {
    const output = formatProviderHealth({
      apiKeyConfigured: false,
      endpointReachable: null,
      message: missingApiKeyMessage("OpenAI", "openai"),
      modelAvailable: null,
      modelConfigured: true,
      modelName: "gpt-4o-mini",
      ok: false,
      providerName: "openai"
    });

    expect(output).toContain("Healthy: no");
    expect(output).toContain("Missing API key for OpenAI");
    expect(output).toContain("Next: talon provider setup openai --api-key <key>");
  });
});

describe("provider setup guidance", () => {
  it("warns when setup omits an API key for real providers", () => {
    const lines = formatProviderSetupNextSteps({
      apiKeyProvided: false,
      baseUrlProvided: false,
      modelProvided: false,
      providerName: "openai"
    });

    expect(lines.join("\n")).toContain("no --api-key was provided");
    expect(lines.join("\n")).toContain("talon provider test");
  });

  it("keeps mock setup free of API key warnings", () => {
    const lines = formatProviderSetupNextSteps({
      apiKeyProvided: false,
      baseUrlProvided: false,
      contextWindowTokens: 32_000,
      modelProvided: false,
      providerName: "mock"
    });

    expect(lines.join("\n")).not.toContain("no --api-key was provided");
    expect(lines).toContain("Check: talon provider status");
    expect(lines).toContain("Test: talon provider test");
  });

  it("warns when openai-compatible is missing base URL or model", () => {
    const lines = formatProviderSetupNextSteps({
      apiKeyProvided: true,
      baseUrlProvided: false,
      modelProvided: false,
      providerName: "openai-compatible"
    });

    expect(lines.join("\n")).toContain("openai-compatible usually needs --base-url and --model");
  });
});
