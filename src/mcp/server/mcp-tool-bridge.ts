import { randomUUID } from "node:crypto";

import type { ToolOrchestrator } from "../../tools/index.js";
import type { AgentProfileId, JsonObject } from "../../types/index.js";

export interface McpExternalIdentity {
  agentProfileId: AgentProfileId;
  runtimeUserId: string;
}

export class McpToolBridge {
  public constructor(
    private readonly toolOrchestrator: ToolOrchestrator,
    private readonly workspaceRoot: string,
    private readonly identity: McpExternalIdentity
  ) {}

  public listTools(allowlist: string[]): Array<{
    description: string;
    inputSchema: JsonObject;
    name: string;
  }> {
    return this.toolOrchestrator
      .listTools(allowlist)
      .map((tool) => ({
        description: tool.description,
        inputSchema: tool.inputSchema,
        name: tool.name
      }));
  }

  public async callTool(input: {
    name: string;
    arguments: JsonObject;
  }): Promise<{ content: JsonObject; status: "approval_required" | "completed" }> {
    const taskId = `mcp-task-${Date.now()}`;
    const outcome = await this.toolOrchestrator.execute(
      {
        input: input.arguments,
        iteration: 1,
        reason: `External MCP call for ${input.name}`,
        taskId,
        toolCallId: randomUUID(),
        toolName: input.name
      },
      {
        agentProfileId: this.identity.agentProfileId,
        cwd: this.workspaceRoot,
        iteration: 1,
        signal: new AbortController().signal,
        taskId,
        userId: this.identity.runtimeUserId,
        workspaceRoot: this.workspaceRoot
      }
    );

    if (outcome.kind === "approval_required") {
      return {
        content: {
          approvalId: outcome.approval.approvalId,
          message: `Approval required for ${input.name}`,
          status: "approval_required"
        },
        status: "approval_required"
      };
    }

    return {
      content: {
        output: outcome.result.output,
        summary: outcome.result.summary
      },
      status: "completed"
    };
  }
}
