import { describe, expect, it } from "vitest";
import { z } from "zod";

import { PolicyEngine } from "../src/policy/policy-engine.js";
import { DEFAULT_LOCAL_POLICY_CONFIG } from "../src/policy/default-policy-config.js";
import { ToolOrchestrator } from "../src/tools/tool-orchestrator.js";
import type {
  ApprovalRecord,
  ToolCallRecord,
  ToolCallRepository,
  ToolDefinition,
  ToolExecutionContext
} from "../src/types/index.js";

describe("ToolOrchestrator network policy", () => {
  it("allows public network fetches without entering manual approval", async () => {
    const records = new Map<string, ToolCallRecord>();
    let approvalRequested = false;
    const fetchSchema = z.object({
      url: z.string().url()
    });
    const tool: ToolDefinition<typeof fetchSchema, { url: string }> = {
      approvalDefault: "when_needed",
      capability: "network.fetch_public_readonly",
      costLevel: "cheap",
      description: "Fetch a public URL",
      execute: (preparedInput) => Promise.resolve({
        output: {
          ok: true,
          url: preparedInput.url
        },
        success: true,
        summary: "fetched"
      }),
      inputSchema: fetchSchema,
      inputSchemaDescriptor: {
        properties: {
          url: { type: "string" }
        },
        required: ["url"],
        type: "object"
      },
      name: "fake_web_fetch",
      prepare: (input) => {
        const parsedInput = fetchSchema.parse(input);
        return {
          governance: {
            pathScope: "network",
            summary: `Fetch ${parsedInput.url}`
          },
          preparedInput: parsedInput,
          sandbox: {
            host: "example.com",
            kind: "network",
            method: "GET",
            networkAccess: "controlled",
            pathScope: "network",
            url: parsedInput.url
          }
        };
      },
      privacyLevel: "restricted",
      riskLevel: "medium",
      sideEffectLevel: "external_read_only",
      toolKind: "external_tool"
    };

    const orchestrator = new ToolOrchestrator({
      approvalService: {
        ensureApprovalRequest: () => {
          approvalRequested = true;
          return {
            approval: {
              approvalId: "approval-1",
              decidedAt: null,
              errorCode: null,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              policyDecisionId: "policy-1",
              reason: "unexpected",
              requestedAt: new Date().toISOString(),
              requesterUserId: "user-1",
              reviewerId: null,
              reviewerNotes: null,
              status: "pending",
              taskId: "task-1",
              toolCallId: "call-1",
              toolName: "fake_web_fetch"
            } satisfies ApprovalRecord,
            created: true
          };
        }
      } as never,
      artifactRepository: {
        createMany: () => undefined
      } as never,
      auditService: {
        record: () => undefined
      } as never,
      contextPolicy: {
        redactText: (value: string) => value
      } as never,
      policyEngine: new PolicyEngine(DEFAULT_LOCAL_POLICY_CONFIG),
      toolCallRepository: createToolCallRepository(records),
      tools: [tool],
      traceService: {
        record: () => undefined
      } as never
    });

    const outcome = await orchestrator.execute(
      {
        input: { url: "https://example.com/docs" },
        iteration: 1,
        reason: "Need current docs",
        taskId: "task-1",
        toolCallId: "call-1",
        toolName: "fake_web_fetch"
      },
      createContext()
    );

    expect(outcome.kind).toBe("completed");
    expect(approvalRequested).toBe(false);
    expect(records.get("call-1")?.status).toBe("finished");
  });

  it("fails early when a tool becomes unavailable at execution time", async () => {
    const records = new Map<string, ToolCallRecord>();
    const tool: ToolDefinition<z.ZodObject<{ value: z.ZodString }>, { value: string }> = {
      approvalDefault: "when_needed",
      capability: "filesystem.read",
      checkAvailability: () => ({
        available: false,
        reason: "dependency missing"
      }),
      costLevel: "cheap",
      description: "Sometimes unavailable tool",
      execute: () =>
        Promise.resolve({
          output: {
            ok: true
          },
          success: true,
          summary: "should not run"
        }),
      inputSchema: z.object({
        value: z.string()
      }),
      inputSchemaDescriptor: {
        properties: {
          value: { type: "string" }
        },
        required: ["value"],
        type: "object"
      },
      name: "unstable_reader",
      prepare: () => ({
        governance: {
          pathScope: "workspace",
          summary: "read"
        },
        preparedInput: {
          value: "ok"
        },
        sandbox: {
          kind: "file",
          operation: "read",
          pathScope: "workspace",
          requestedPath: ".",
          resolvedPath: ".",
          withinExtraWriteRoot: false
        }
      }),
      privacyLevel: "internal",
      riskLevel: "low",
      sideEffectLevel: "read_only",
      toolKind: "runtime_primitive"
    };

    const orchestrator = new ToolOrchestrator({
      approvalService: {
        ensureApprovalRequest: () => {
          throw new Error("approval should not be requested");
        }
      } as never,
      artifactRepository: {
        createMany: () => undefined
      } as never,
      auditService: {
        record: () => undefined
      } as never,
      contextPolicy: {
        redactText: (value: string) => value
      } as never,
      policyEngine: new PolicyEngine(DEFAULT_LOCAL_POLICY_CONFIG),
      toolCallRepository: createToolCallRepository(records),
      tools: [tool],
      traceService: {
        record: () => undefined
      } as never
    });

    await expect(
      orchestrator.execute(
        {
          input: { value: "hello" },
          iteration: 1,
          reason: "Need file context",
          taskId: "task-2",
          toolCallId: "call-2",
          toolName: "unstable_reader"
        },
        createContext()
      )
    ).rejects.toMatchObject({
      code: "tool_unavailable"
    });
    expect(records.get("call-2")?.status).toBe("failed");
  });
});

function createContext(): ToolExecutionContext {
  return {
    agentProfileId: "executor",
    cwd: process.cwd(),
    iteration: 1,
    signal: new AbortController().signal,
    taskId: "task-1",
    userId: "user-1",
    workspaceRoot: process.cwd()
  };
}

function createToolCallRepository(
  records: Map<string, ToolCallRecord>
): ToolCallRepository {
  return {
    create(input) {
      const record = {
        ...input
      } as ToolCallRecord;
      records.set(record.toolCallId, record);
      return record;
    },
    findById(toolCallId) {
      return records.get(toolCallId) ?? null;
    },
    listByTaskId(taskId) {
      return [...records.values()].filter((record) => record.taskId === taskId);
    },
    update(toolCallId, patch) {
      const current = records.get(toolCallId);
      if (current === undefined) {
        throw new Error(`Tool call ${toolCallId} not found`);
      }
      const next = {
        ...current,
        ...patch
      };
      records.set(toolCallId, next);
      return next;
    }
  };
}
