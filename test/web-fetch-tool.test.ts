import { describe, expect, it } from "vitest";

import { SandboxService } from "../src/sandbox/sandbox-service";
import { WebFetchTool } from "../src/tools/web-fetch-tool";
import type { ToolExecutionContext } from "../src/types";

describe("WebFetchTool", () => {
  it("uses manual redirect mode to prevent host-allowlist bypass via redirects", async () => {
    const sandboxService = new SandboxService({
      allowedFetchHosts: ["example.com"],
      workspaceRoot: process.cwd()
    });
    let requestInit: RequestInit | null = null;
    const tool = new WebFetchTool(sandboxService, {
      fetch: async (_input, init) => {
        requestInit = init;
        return new Response("ok", {
          status: 200
        });
      }
    });

    const prepared = tool.prepare(
      {
        url: "https://example.com/page"
      },
      createContext()
    );

    await tool.execute(prepared.preparedInput, createContext());
    expect(requestInit?.redirect).toBe("manual");
  });

  it("returns tool_execution_error when upstream HTTP status is not ok", async () => {
    const sandboxService = new SandboxService({
      allowedFetchHosts: ["example.com"],
      workspaceRoot: process.cwd()
    });
    const tool = new WebFetchTool(sandboxService, {
      fetch: async () =>
        new Response("not found", {
          status: 404
        })
    });

    const prepared = tool.prepare(
      {
        url: "https://example.com/missing"
      },
      createContext()
    );

    const result = await tool.execute(prepared.preparedInput, createContext());
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected web_fetch to return a failure result.");
    }
    expect(result.errorCode).toBe("tool_execution_error");
    expect(result.details?.status).toBe(404);
  });
});

function createContext(): ToolExecutionContext {
  return {
    agentProfileId: "executor",
    cwd: process.cwd(),
    iteration: 1,
    signal: new AbortController().signal,
    taskId: "task-web-fetch-test",
    userId: "test-user",
    workspaceRoot: process.cwd()
  };
}
