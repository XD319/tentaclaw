import { describe, expect, it } from "vitest";

import { McpToolAdapter } from "../src/mcp/index.js";
import { ToolOrchestrator } from "../src/tools/index.js";
import type {
  AuditAction,
  AuditOutcome,
  ApprovalRecord,
  McpToolCallResult,
  TraceEventType,
  ToolCallRecord,
  ToolCallRepository,
  ToolExecutionContext
} from "../src/types/index.js";

describe("McpToolAdapter orchestration", () => {
  it("runs through policy, trace, and audit paths", async () => {
    const traceEvents: TraceEventType[] = [];
    const auditActions: AuditAction[] = [];
    const records = new Map<string, ToolCallRecord>();
    const adapter = new McpToolAdapter(
      {
        description: "Echo",
        inputSchema: { type: "object" },
        name: "echo",
        serverId: "fake"
      },
      {
        args: [],
        command: "node",
        env: {},
        id: "fake",
        privacyLevel: "internal",
        riskLevel: "high"
      },
      {
        callTool: () =>
          Promise.resolve({
            content: { ok: true }
          } as McpToolCallResult),
        close: () => Promise.resolve(),
        listTools: () => Promise.resolve([]),
        ping: () => Promise.resolve(),
        serverId: "fake"
      }
    );

    const orchestrator = new ToolOrchestrator({
      approvalService: {
        ensureApprovalRequest: () => ({
          approval: {
            approvalId: "approval-1",
            createdAt: new Date().toISOString(),
            decision: null,
            decidedAt: null,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            policyDecisionId: "policy-1",
            reason: "test",
            requestedByUserId: "u-1",
            reviewerUserId: null,
            status: "approved",
            taskId: "task-1",
            toolCallId: "call-1",
            toolName: "mcp__fake__echo"
          } as ApprovalRecord,
          created: false
        })
      } as never,
      artifactRepository: {
        createMany: () => undefined
      } as never,
      auditService: {
        record: (entry: { action: AuditAction; outcome: AuditOutcome }) => {
          auditActions.push(entry.action);
          void entry.outcome;
        }
      } as never,
      contextPolicy: {
        redactText: (value: string) => value
      } as never,
      policyEngine: {
        evaluate: () => ({
          decisionId: "policy-1",
          effect: "allow",
          matchedRuleId: "rule-1",
          reason: "allowed"
        })
      } as never,
      toolCallRepository: createToolCallRepository(records),
      tools: [adapter],
      traceService: {
        record: (entry: { eventType: TraceEventType }) => {
          traceEvents.push(entry.eventType);
        }
      } as never
    });

    const outcome = await orchestrator.execute(
      {
        input: { text: "hello" },
        iteration: 1,
        reason: "test",
        taskId: "task-1",
        toolCallId: "call-1",
        toolName: "mcp__fake__echo"
      },
      createContext()
    );

    expect(outcome.kind).toBe("completed");
    expect(traceEvents).toContain("policy_decision");
    expect(traceEvents).toContain("tool_call_started");
    expect(traceEvents).toContain("tool_call_finished");
    expect(auditActions).toContain("policy_decision");
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
