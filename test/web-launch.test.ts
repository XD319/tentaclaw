import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { startWebUi } from "../src/cli/web-launch.js";
import { TALON_HTTP_COOKIE_NAME } from "../src/core/http-auth.js";

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined) {
      await rm(tempPath, { force: true, recursive: true });
    }
  }
});

describe("web launcher", () => {
  it("auto-inits a workspace, serves HTML with an auth cookie, and exposes bootstrap", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "auto-talon-web-"));
    tempPaths.push(workspaceRoot);
    const port = await getFreePort();
    const started = await startWebUi({
      cwd: workspaceRoot,
      host: "127.0.0.1",
      open: false,
      port
    });

    try {
      const home = await fetch(started.url);
      expect(home.status).toBe(200);
      expect(home.headers.get("content-type") ?? "").toContain("text/html");
      const html = await home.text();
      expect(html).toContain("AutoTalon");
      const cookie = home.headers.get("set-cookie") ?? "";
      expect(cookie).toContain(TALON_HTTP_COOKIE_NAME);

      const bootstrap = await fetch(`${started.url}/v1/bootstrap`, {
        headers: { cookie }
      });
      expect(bootstrap.status).toBe(200);
      const body = (await bootstrap.json()) as { workspaceRoot: string; catalog: string[] };
      expect(body.workspaceRoot).toBe(workspaceRoot);
      expect(body.catalog).toContain("mock");

      const unauthorized = await fetch(`${started.url}/v1/bootstrap`);
      expect(unauthorized.status).toBe(401);

      const setup = await fetch(`${started.url}/v1/providers/setup`, {
        body: JSON.stringify({ name: "mock" }),
        headers: { "content-type": "application/json", cookie },
        method: "POST"
      });
      expect(setup.status).toBe(200);

      const created = await fetch(`${started.url}/v1/sessions`, {
        body: JSON.stringify({ title: "Web session" }),
        headers: { "content-type": "application/json", cookie },
        method: "POST"
      });
      expect(created.status).toBe(201);
      const sessionBody = (await created.json()) as { session: { sessionId: string } };
      const turn = await fetch(`${started.url}/v1/sessions/${sessionBody.session.sessionId}/turns`, {
        body: JSON.stringify({ input: "say hello" }),
        headers: { "content-type": "application/json", cookie },
        method: "POST"
      });
      expect(turn.status).toBe(202);
      const turnBody = (await turn.json()) as { taskId: string };
      expect(turnBody.taskId.length).toBeGreaterThan(0);
    } finally {
      await started.close();
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
