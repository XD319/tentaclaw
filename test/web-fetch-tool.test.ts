import { describe, expect, it } from "vitest";

import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { WebFetchTool } from "../src/tools/web-fetch-tool.js";
import type { ToolExecutionContext } from "../src/types/index.js";

describe("WebFetchTool", () => {
  it("uses manual redirect mode to prevent host-allowlist bypass via redirects", async () => {
    const sandboxService = new SandboxService({
      allowedFetchHosts: ["example.com"],
      workspaceRoot: process.cwd()
    });
    let requestInit: RequestInit | null = null;
    const tool = new WebFetchTool(sandboxService, {
      fetch: (_input, init) => {
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
      fetch: () =>
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

  it("follows allowed redirects and rejects disallowed redirect targets", async () => {
    const sandboxService = new SandboxService({
      allowedFetchHosts: ["example.com", "*.example.com"],
      workspaceRoot: process.cwd()
    });

    let callCount = 0;
    const tool = new WebFetchTool(sandboxService, {
      fetch: () => {
        callCount += 1;
        if (callCount === 1) {
          return new Response("", {
            headers: {
              location: "https://docs.example.com/final"
            },
            status: 302
          });
        }
        return new Response("final body", {
          status: 200
        });
      }
    });

    const prepared = tool.prepare(
      {
        url: "https://example.com/start"
      },
      createContext()
    );

    const result = await tool.execute(prepared.preparedInput, createContext());
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected redirect flow to succeed.");
    }
    const output = result.output as {
      redirectTrace: Array<{ status: number; url: string }>;
      url: string;
    };
    expect(output.redirectTrace).toHaveLength(2);
    expect(output.redirectTrace[1]?.url).toBe("https://docs.example.com/final");
  });

  it("extracts readable text from HTML responses", async () => {
    const sandboxService = new SandboxService({
      allowedFetchHosts: ["example.com"],
      workspaceRoot: process.cwd()
    });
    const html = `
      <html>
        <head><title>DocTitle</title><script>console.log("x")</script></head>
        <body><main>Hello <b>World</b></main></body>
      </html>
    `;
    const tool = new WebFetchTool(sandboxService, {
      fetch: () =>
        new Response(html, {
          headers: {
            "content-type": "text/html; charset=utf-8"
          },
          status: 200
        })
    });

    const prepared = tool.prepare(
      {
        url: "https://example.com/doc"
      },
      createContext()
    );

    const result = await tool.execute(prepared.preparedInput, createContext());
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected html fetch to succeed.");
    }
    const output = result.output as { body: string; extractedTitle: string | null };
    expect(output.extractedTitle).toBe("DocTitle");
    expect(output.body).toContain("Hello World");
    expect(output.body).not.toContain("console.log");
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
