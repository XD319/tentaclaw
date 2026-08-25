import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import { createApplication } from "../src/runtime/index.js";
import { startSessionApiServer } from "../src/session-api/server.js";
import { withWorkspaceAuthHeaders } from "./helpers/http-auth-headers.js";
import type { Provider, ProviderInput, ProviderResponse } from "../src/types/index.js";

class ScriptedProvider implements Provider {
  public readonly name = "session-api-provider";
  public generate(input: ProviderInput): Promise<ProviderResponse> {
    void input;
    return Promise.resolve({
      kind: "final",
      message: "session api ok",
      usage: { inputTokens: 1, outputTokens: 1 }
    });
  }
}

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined) {
      await import("node:fs/promises").then((fs) => fs.rm(tempPath, { force: true, recursive: true }));
    }
  }
});

describe("session HTTP API", () => {
  it("lists sessions, returns messages, searches, and continues", async () => {
    const workspaceRoot = await import("node:fs/promises").then((fs) =>
      fs.mkdtemp(join(tmpdir(), "auto-talon-session-api-"))
    );
    tempPaths.push(workspaceRoot);
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") },
      provider: new ScriptedProvider()
    });
    const port = await getFreePort();
    const server = await startSessionApiServer({
      cwd: workspaceRoot,
      host: "127.0.0.1",
      port,
      service: handle.service
    });

    try {
      const session = handle.service.createSession({
        agentProfileId: "executor",
        cwd: workspaceRoot,
        metadata: { source: "cli" },
        ownerUserId: "local-user",
        providerName: "mock",
        title: "API session"
      });
      handle.service.saveSessionUiState(session.sessionId, {
        entrySource: "cli",
        messages: [
          {
            id: "user-api",
            kind: "user",
            text: "hello session api",
            timestamp: "2026-01-01T00:00:00.000Z"
          }
        ]
      });

      const listResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
        headers: withWorkspaceAuthHeaders(workspaceRoot)
      });
      expect(listResponse.status).toBe(200);
      const listBody = (await listResponse.json()) as { sessions: Array<{ sessionId: string }> };
      expect(listBody.sessions.some((entry) => entry.sessionId === session.sessionId)).toBe(true);

      const messagesResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions/${session.sessionId}/messages`, {
        headers: withWorkspaceAuthHeaders(workspaceRoot)
      });
      expect(messagesResponse.status).toBe(200);
      const messagesBody = (await messagesResponse.json()) as { messages: Array<{ kind: string }> };
      expect(messagesBody.messages).toHaveLength(1);

      const searchResponse = await fetch(
        `http://127.0.0.1:${port}/v1/sessions/search?q=${encodeURIComponent("session api")}`,
        { headers: withWorkspaceAuthHeaders(workspaceRoot) }
      );
      expect(searchResponse.status).toBe(200);
      const searchBody = (await searchResponse.json()) as { hits: unknown[] };
      expect(searchBody.hits.length).toBeGreaterThan(0);

      const invalidJsonResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions/${session.sessionId}/continue`, {
        body: "not-json",
        headers: withWorkspaceAuthHeaders(workspaceRoot, { "content-type": "application/json" }),
        method: "POST"
      });
      expect(invalidJsonResponse.status).toBe(400);
      const invalidBody = (await invalidJsonResponse.json()) as { error: string };
      expect(invalidBody.error).toBe("invalid_json");

      const continueResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions/${session.sessionId}/continue`, {
        body: JSON.stringify({ input: "follow up" }),
        headers: withWorkspaceAuthHeaders(workspaceRoot, { "content-type": "application/json" }),
        method: "POST"
      });
      expect(continueResponse.status).toBe(200);
      const continueBody = (await continueResponse.json()) as { taskId: string };
      expect(continueBody.taskId.length).toBeGreaterThan(0);
    } finally {
      await server.close();
      handle.close();
    }
  });

  it("exposes and updates session model selections", async () => {
    const fs = await import("node:fs/promises");
    const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-session-model-api-"));
    tempPaths.push(workspaceRoot);
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify({ version: 1 }),
      "utf8"
    );
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "provider.config.json"),
      JSON.stringify({
        currentProvider: "vendor-a",
        customProviders: {
          "vendor-a": {
            transport: "openai-compatible",
            displayName: "Vendor A",
            baseUrl: "https://vendor-a.example.test/v1",
            apiKey: "vendor-a-key",
            model: "vendor-a-model"
          },
          "vendor-b": {
            transport: "openai-compatible",
            displayName: "Vendor B",
            baseUrl: "https://vendor-b.example.test/v1",
            apiKey: "vendor-b-key",
            model: "vendor-b-model"
          }
        }
      }),
      "utf8"
    );

    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") }
    });
    const port = await getFreePort();
    const server = await startSessionApiServer({
      cwd: workspaceRoot,
      host: "127.0.0.1",
      port,
      service: handle.service
    });

    try {
      const session = handle.service.createSession({
        agentProfileId: "executor",
        cwd: workspaceRoot,
        metadata: {},
        ownerUserId: "local-user",
        providerName: "vendor-a",
        title: "Model API session"
      });

      const modelsResponse = await fetch(`http://127.0.0.1:${port}/v1/models?sessionId=${session.sessionId}`, {
        headers: withWorkspaceAuthHeaders(workspaceRoot)
      });
      expect(modelsResponse.status).toBe(200);
      const modelsJson = await modelsResponse.text();
      expect(modelsJson).not.toContain("vendor-a-key");
      expect(modelsJson).not.toContain("vendor-b-key");
      const modelsBody = JSON.parse(modelsJson) as { configuredModels: Array<{ selection: string }> };
      expect(modelsBody.configuredModels.map((entry) => entry.selection)).toContain("vendor-b:vendor-b-model");

      const bootstrapResponse = await fetch(`http://127.0.0.1:${port}/v1/bootstrap`, {
        headers: withWorkspaceAuthHeaders(workspaceRoot)
      });
      expect(bootstrapResponse.status).toBe(200);
      const bootstrapJson = await bootstrapResponse.text();
      expect(bootstrapJson).not.toContain("vendor-a-key");
      expect(bootstrapJson).not.toContain("vendor-b-key");
      expect(bootstrapJson).not.toMatch(/"apiKey"\s*:/u);

      const setResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions/${session.sessionId}/model`, {
        body: JSON.stringify({ selection: "vendor-b:vendor-b-model" }),
        headers: withWorkspaceAuthHeaders(workspaceRoot, { "content-type": "application/json" }),
        method: "PATCH"
      });
      expect(setResponse.status).toBe(200);
      const setBody = (await setResponse.json()) as {
        modelSelection: { selection: string; source: string } | null;
        view: { current: { selection: string; source: string } };
      };
      expect(setBody.modelSelection?.selection).toBe("vendor-b:vendor-b-model");
      expect(setBody.view.current.source).toBe("session_user");

      const detailResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions/${session.sessionId}`, {
        headers: withWorkspaceAuthHeaders(workspaceRoot)
      });
      expect(detailResponse.status).toBe(200);
      const detailBody = (await detailResponse.json()) as { modelSelection: { selection: string } | null };
      expect(detailBody.modelSelection?.selection).toBe("vendor-b:vendor-b-model");

      const clearResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions/${session.sessionId}/model`, {
        body: JSON.stringify({ selection: null }),
        headers: withWorkspaceAuthHeaders(workspaceRoot, { "content-type": "application/json" }),
        method: "PATCH"
      });
      expect(clearResponse.status).toBe(200);
      const clearBody = (await clearResponse.json()) as {
        modelSelection: { selection: string } | null;
        view: { current: { selection: string; source: string } };
      };
      expect(clearBody.modelSelection).toBeNull();
      expect(clearBody.view.current.source).not.toBe("session_user");

      const invalidResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions/${session.sessionId}/model`, {
        body: JSON.stringify({ selection: "" }),
        headers: withWorkspaceAuthHeaders(workspaceRoot, { "content-type": "application/json" }),
        method: "PATCH"
      });
      expect(invalidResponse.status).toBe(400);
    } finally {
      await server.close();
      handle.close();
    }
  });
});

async function getFreePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Failed to allocate an ephemeral port.");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error !== undefined ? reject(error) : resolve()));
  });
  return port;
}


