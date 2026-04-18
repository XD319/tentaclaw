import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";

import type {
  AdapterDescriptor,
  GatewayRuntimeApi,
  GatewayTaskRequest,
  InboundMessageAdapter,
  OutboundResponseAdapter
} from "../types";

export interface LocalWebhookAdapterOptions {
  adapterId?: string;
  host?: string;
  port: number;
}

export class LocalWebhookAdapter implements InboundMessageAdapter, OutboundResponseAdapter {
  public readonly descriptor: AdapterDescriptor;

  private server: Server | null = null;
  private runtimeApi: GatewayRuntimeApi | null = null;

  public constructor(private readonly options: LocalWebhookAdapterOptions) {
    this.descriptor = {
      adapterId: this.options.adapterId ?? "local-webhook",
      capabilities: {
        approvalInteraction: {
          detail: "Returns approval state but does not resolve approvals inline.",
          supported: false
        },
        fileCapability: {
          detail: "Returns artifact references only.",
          supported: false
        },
        streamingCapability: {
          detail: "Supports SSE event streams.",
          supported: true
        },
        structuredCardCapability: {
          detail: "Falls back to plain JSON responses.",
          supported: false
        },
        textInteraction: {
          detail: "JSON request and response bodies.",
          supported: true
        }
      },
      description: "Minimal local HTTP adapter for webhook / SDK style integration.",
      displayName: "Local Webhook Adapter",
      kind: "webhook",
      lifecycleState: "created"
    };
  }

  public async start(context: { runtimeApi: GatewayRuntimeApi }): Promise<void> {
    this.runtimeApi = context.runtimeApi;
    this.server = createServer((request, response) => {
      void this.handleRequestSafely(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.options.port, this.options.host ?? "127.0.0.1", () => {
        this.server?.off("error", reject);
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    if (this.server === null) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => {
        if (error !== undefined && error !== null) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    this.server = null;
    this.runtimeApi = null;
  }

  public sendEvent(): Promise<void> {
    return Promise.resolve();
  }

  public sendResult(): Promise<void> {
    return Promise.resolve();
  }

  private async handleRequestSafely(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    try {
      await this.handleRequest(request, response);
    } catch {
      if (response.headersSent) {
        response.end();
        return;
      }
      this.respondJson(response, 500, { error: "internal_error" });
    }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.runtimeApi === null) {
      this.respondJson(response, 503, {
        error: "adapter_not_ready"
      });
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    if (request.method === "POST" && url.pathname === "/tasks") {
      const payload = await readJsonBody<GatewayTaskRequest>(request);
      const result = await this.runtimeApi.submitTask(this.descriptor, payload);
      this.respondJson(response, 200, result);
      return;
    }

    if (request.method === "GET" && /^\/tasks\/[^/]+$/.test(url.pathname)) {
      const taskId = url.pathname.split("/")[2] ?? "";
      const snapshot = this.runtimeApi.getTaskSnapshot(taskId);
      if (snapshot === null) {
        this.respondJson(response, 404, { error: "task_not_found" });
        return;
      }

      this.respondJson(response, 200, snapshot);
      return;
    }

    if (request.method === "GET" && /^\/tasks\/[^/]+\/events$/.test(url.pathname)) {
      const taskId = url.pathname.split("/")[2] ?? "";
      const snapshot = this.runtimeApi.getTaskSnapshot(taskId);
      if (snapshot === null) {
        this.respondJson(response, 404, { error: "task_not_found" });
        return;
      }

      response.writeHead(200, {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream"
      });

      for (const trace of snapshot.trace) {
        response.write(`data: ${JSON.stringify({ kind: "trace", taskId, trace })}\n\n`);
      }
      for (const audit of snapshot.audit) {
        response.write(`data: ${JSON.stringify({ kind: "audit", taskId, audit })}\n\n`);
      }
      for (const notice of snapshot.notices) {
        response.write(`data: ${JSON.stringify({ kind: "gateway_notice", taskId, notice })}\n\n`);
      }

      if (isTerminalStatus(snapshot.task.status)) {
        response.end();
        return;
      }

      const unsubscribe = this.runtimeApi.subscribeToTaskEvents(taskId, (event) => {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      });

      request.on("close", () => {
        unsubscribe();
        response.end();
      });
      return;
    }

    this.respondJson(response, 404, {
      error: "not_found"
    });
  }

  private respondJson(response: ServerResponse, statusCode: number, payload: unknown): void {
    response.writeHead(statusCode, {
      "Content-Type": "application/json"
    });
    response.end(JSON.stringify(payload, null, 2));
  }
}

function isTerminalStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
      continue;
    }

    if (chunk instanceof Uint8Array) {
      chunks.push(Buffer.from(chunk));
      continue;
    }

    chunks.push(Buffer.from(String(chunk)));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) {
    return {} as T;
  }

  return JSON.parse(raw) as T;
}
