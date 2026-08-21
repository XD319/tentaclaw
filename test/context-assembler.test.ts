import { describe, expect, it } from "vitest";

import {
  ExecutionContextAssembler,
  MEMORY_CONTEXT_SOURCE_TYPE,
  mergeMemoryContextIntoMessages
} from "../src/runtime/context-assembler.js";
import type { AgentProfile, ContextFragment, TaskRecord } from "../src/types/index.js";

describe("ExecutionContextAssembler", () => {
  it("describes public web fetch usage in the initial system prompt", () => {
    const assembler = new ExecutionContextAssembler();
    const messages = assembler.buildInitialMessages(
      createTask(),
      [
        {
          capability: "network.fetch_public_readonly",
          description: "Fetch a public URL",
          inputSchema: { type: "object" },
          name: "web_extract",
          privacyLevel: "restricted",
          riskLevel: "medium"
        }
      ],
      createProfile()
    );

    expect(messages[0]?.content).toContain("When web_extract is available");
    expect(messages[0]?.content).toContain("read public web pages");
    expect(messages[0]?.content).toContain("Visible tools may still be denied");
    expect(messages[0]?.content).toContain("Available tools: web_extract.");
  });

  it("warns when web_search uses best-effort ddgs scraping", () => {
    const assembler = new ExecutionContextAssembler();
    const messages = assembler.buildInitialMessages(
      createTask(),
      [
        {
          capability: "network.fetch_public_readonly",
          description: "Search the public web",
          inputSchema: { type: "object" },
          name: "web_search",
          privacyLevel: "restricted",
          riskLevel: "medium"
        }
      ],
      createProfile(),
      undefined,
      [],
      undefined,
      { searchBackend: "ddgs" }
    );

    expect(messages[0]?.content).toContain("best-effort");
    expect(messages[0]?.content).toContain("BRAVE_SEARCH_API_KEY");
  });

  it("keeps the initial system prompt concise when web fetch is unavailable", () => {
    const assembler = new ExecutionContextAssembler();
    const messages = assembler.buildInitialMessages(
      createTask(),
      [
        {
          capability: "filesystem.read",
          description: "Read a local file",
          inputSchema: { type: "object" },
          name: "read_file",
          privacyLevel: "internal",
          riskLevel: "low"
        }
      ],
      createProfile()
    );

    expect(messages[0]?.content).not.toContain("When web_extract is available");
    expect(messages[0]?.content).toContain("Visible tools may still be denied");
    expect(messages[0]?.content).toContain("Available tools: read_file.");
  });

  it("injects full web_search unavailability guidance whenever web_search is unavailable", () => {
    const assembler = new ExecutionContextAssembler();
    const messages = assembler.buildInitialMessages(
      {
        ...createTask(),
        input: "search web for skills and mcp differences"
      },
      [
        {
          capability: "network.fetch_public_readonly",
          description: "Fetch a public URL",
          inputSchema: { type: "object" },
          name: "web_extract",
          privacyLevel: "restricted",
          riskLevel: "medium"
        }
      ],
      createProfile(),
      undefined,
      [
        {
          exposed: false,
          reason: "unavailable: web_search backend is disabled",
          toolName: "web_search"
        }
      ]
    );

    expect(messages[0]?.content).toContain("web_search is unavailable: web_search backend is disabled");
    expect(messages[0]?.content).toContain("Do not answer from general knowledge");
    expect(messages[0]?.content).toContain("FIRECRAWL_API_KEY");
    expect(messages[0]?.content).toContain("cannot discover search results");
  });

  it("injects plan mode guidance into the initial system prompt", () => {
    const assembler = new ExecutionContextAssembler();
    const messages = assembler.buildInitialMessages(
      createTask(),
      [
        {
          capability: "filesystem.read",
          description: "Read a local file",
          inputSchema: { type: "object" },
          name: "read_file",
          privacyLevel: "internal",
          riskLevel: "low"
        }
      ],
      createProfile(),
      undefined,
      [],
      "plan"
    );

    expect(messages[0]?.content).toContain("You are in plan mode");
    expect(messages[0]?.content).toContain("/mode agent");
  });

  it("merges memoryContext recall fragments into provider messages", () => {
    const assembler = new ExecutionContextAssembler();
    const fragments = [createMemoryFragment()];
    const assembled = assembler.assemble({
      availableTools: [],
      iteration: 1,
      memoryContext: fragments,
      messages: [
        {
          content: "You are a coding agent.",
          metadata: {
            privacyLevel: "internal",
            retentionKind: "working",
            sourceType: "system_prompt"
          },
          role: "system"
        },
        {
          content: "fix the bug",
          metadata: {
            privacyLevel: "internal",
            retentionKind: "working",
            sourceType: "user_input"
          },
          role: "user"
        }
      ],
      signal: new AbortController().signal,
      task: createTask(),
      tokenBudget: createTask().tokenBudget
    });

    const recalledMessage = assembled.providerInput.messages.find(
      (message) => message.metadata?.sourceType === MEMORY_CONTEXT_SOURCE_TYPE
    );
    expect(recalledMessage?.role).toBe("system");
    expect(recalledMessage?.content).toContain("Recalled context:");
    expect(recalledMessage?.content).toContain("Use pnpm for verification");
    expect(assembled.memoryContextInjection?.fragmentCount).toBe(1);
    expect(typeof assembled.memoryContextInjection?.tokenEstimate).toBe("number");
    expect(assembled.providerInput.memoryContext).toEqual(fragments);
  });

  it("replaces an existing recalled-context message on re-assembly", () => {
    const existing = mergeMemoryContextIntoMessages(
      [
        {
          content: "system",
          role: "system"
        }
      ],
      [createMemoryFragment()]
    ).messages;
    const next = mergeMemoryContextIntoMessages(existing, [
      {
        ...createMemoryFragment(),
        text: "Updated recall text"
      }
    ]);

    const recalledMessages = next.messages.filter(
      (message) => message.metadata?.sourceType === MEMORY_CONTEXT_SOURCE_TYPE
    );
    expect(recalledMessages).toHaveLength(1);
    expect(recalledMessages[0]?.content).toContain("Updated recall text");
  });

  it("orders the leading system prefix stable then variable without moving later turns", () => {
    const assembler = new ExecutionContextAssembler();
    const assembled = assembler.assemble({
      availableTools: [],
      iteration: 1,
      memoryContext: [createMemoryFragment()],
      messages: [
        {
          content: "You are a coding agent.",
          metadata: { privacyLevel: "internal", retentionKind: "working", sourceType: "system_prompt" },
          role: "system"
        },
        {
          content: "- [pending] 1: finish tests",
          metadata: { pinned: true, privacyLevel: "internal", retentionKind: "session", sourceType: "session_todos" },
          role: "system"
        },
        {
          content: "Repo map: src/app.ts",
          metadata: { privacyLevel: "internal", retentionKind: "working", sourceType: "system_prompt" },
          role: "system"
        },
        {
          content: "implement slugify",
          metadata: { privacyLevel: "internal", retentionKind: "working", sourceType: "user_input" },
          role: "user"
        },
        {
          content: "Recovery attempt: continue.",
          metadata: { privacyLevel: "internal", retentionKind: "session", sourceType: "system_prompt" },
          role: "system"
        }
      ],
      signal: new AbortController().signal,
      task: createTask(),
      tokenBudget: createTask().tokenBudget
    });

    const rolesAndSources = assembled.providerInput.messages.map((message) => [
      message.role,
      message.metadata?.sourceType ?? null
    ]);
    expect(rolesAndSources).toEqual([
      ["system", "system_prompt"],
      ["system", "system_prompt"],
      ["system", MEMORY_CONTEXT_SOURCE_TYPE],
      ["system", "session_todos"],
      ["user", "user_input"],
      ["system", "system_prompt"]
    ]);
    expect(assembled.providerInput.messages[0]?.content).toContain("You are a coding agent.");
    expect(assembled.providerInput.messages[1]?.content).toContain("Repo map");
    expect(assembled.providerInput.messages[5]?.content).toContain("Recovery attempt");
  });
});

function createProfile(): AgentProfile {
  return {
    description: "Executor profile",
    displayName: "Executor",
    id: "executor",
    systemPrompt: "You are a coding agent."
  };
}

function createTask(): TaskRecord {
  const now = new Date().toISOString();
  return {
    agentProfileId: "executor",
    createdAt: now,
    currentIteration: 0,
    cwd: process.cwd(),
    errorCode: null,
    errorMessage: null,
    finalOutput: null,
    finishedAt: null,
    input: "check today's weather in New York",
    maxIterations: 4,
    metadata: {},
    providerName: "test-provider",
    requesterUserId: "user-1",
    startedAt: now,
    status: "running",
    taskId: "task-context-1",
    tokenBudget: {
      inputLimit: 8_000,
      outputLimit: 2_000,
      reservedOutput: 500,
      usedInput: 0,
      usedOutput: 0
    },
    updatedAt: now
  };
}

function createMemoryFragment(): ContextFragment {
  return {
    confidence: 0.9,
    memoryId: "memory:project:smoke",
    privacyLevel: "internal",
    retentionPolicy: {
      kind: "project",
      reason: "Project memory",
      ttlDays: null
    },
    scope: "project",
    status: "active",
    text: "Use pnpm for verification",
    title: "Smoke verification"
  };
}
