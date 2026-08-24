import { createServer } from "node:http";

import type { AgentApplicationService } from "../runtime/application-service.js";
import { handleSessionApiRequest } from "./router.js";
import { SessionTurnManager } from "./turn-manager.js";

export interface SessionApiServerOptions {
  cwd?: string;
  host?: string;
  port: number;
  service: AgentApplicationService;
}

export function createSessionApiServer(options: SessionApiServerOptions) {
  const cwd = options.cwd ?? process.cwd();
  const turns = new SessionTurnManager();
  return createServer((request, response) => {
    void handleSessionApiRequest({ cwd, service: options.service, turns }, request, response);
  });
}

export async function startSessionApiServer(options: SessionApiServerOptions): Promise<{
  close: () => Promise<void>;
  url: string;
}> {
  const server = createSessionApiServer(options);
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port =
    address !== null && typeof address === "object" ? address.port : options.port;
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error !== undefined ? reject(error) : resolve()));
      }),
    url: `http://${host}:${port}`
  };
}
