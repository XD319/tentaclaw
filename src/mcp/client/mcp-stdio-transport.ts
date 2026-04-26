import { spawn, spawnSync } from "node:child_process";

import { AppError } from "../../runtime/app-error.js";
import type {
  JsonObject,
  JsonValue,
  McpClientHandle,
  McpInvocationContext,
  McpServerConfig,
  McpToolCallRequest,
  McpToolCallResult,
  McpToolDescriptor
} from "../../types/index.js";

interface JsonRpcMessage {
  id?: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

export class McpStdioTransport implements McpClientHandle {
  private static readonly REQUEST_TIMEOUT_MS = 30_000;
  public readonly serverId: string;

  public constructor(private readonly config: McpServerConfig) {
    this.serverId = config.id;
  }

  public listTools(): Promise<McpToolDescriptor[]> {
    return Promise.resolve(this.listToolsSync());
  }

  public listToolsSync(): McpToolDescriptor[] {
    const response = this.request("tools/list", {});
    const payload = asObject(response.result);
    const tools = asArray(payload.tools);
    return tools.map((tool) => {
      const parsed = asObject(tool);
      return {
        description: asString(parsed.description, ""),
        inputSchema: asJsonObject(parsed.inputSchema),
        name: asString(parsed.name),
        serverId: this.serverId
      };
    });
  }

  public callTool(
    request: McpToolCallRequest,
    context?: McpInvocationContext
  ): Promise<McpToolCallResult> {
    if (context?.signal?.aborted === true) {
      return Promise.reject(
        new AppError({
          code: "interrupt",
          message: `MCP tool call aborted before start: ${this.serverId}/${request.toolName}`
        })
      );
    }
    return this.requestAsync(
      "tools/call",
      {
        arguments: request.input,
        name: request.toolName
      },
      context
    ).then((response) => {
      const payload = asObject(response.result);
      return {
        content: (payload.content ?? payload) as McpToolCallResult["content"]
      };
    });
  }

  public callToolSync(
    request: McpToolCallRequest,
    context?: McpInvocationContext
  ): McpToolCallResult {
    if (context?.signal?.aborted === true) {
      throw new AppError({
        code: "interrupt",
        message: `MCP tool call aborted before start: ${this.serverId}/${request.toolName}`
      });
    }

    const response = this.request("tools/call", {
      arguments: request.input,
      name: request.toolName
    });

    const payload = asObject(response.result);
    return {
      content: (payload.content ?? payload) as McpToolCallResult["content"]
    };
  }

  public ping(): Promise<void> {
    this.pingSync();
    return Promise.resolve();
  }

  public pingSync(): void {
    this.request("tools/list", {});
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }

  private request(method: string, params: Record<string, unknown>): JsonRpcMessage {
    const initializeId = 1;
    const methodId = 2;
    const requests = [
      {
        id: initializeId,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          clientInfo: {
            name: "auto-talon",
            version: "phase5"
          },
          protocolVersion: "2024-11-05"
        }
      },
      {
        id: methodId,
        jsonrpc: "2.0",
        method,
        params
      }
    ];
    const input = `${requests.map((item) => JSON.stringify(item)).join("\n")}\n`;
    const output = spawnSync(this.config.command, this.config.args, {
      encoding: "utf8",
      env: {
        ...process.env,
        ...this.config.env
      },
      input,
      timeout: McpStdioTransport.REQUEST_TIMEOUT_MS
    });

    if (output.error !== undefined) {
      throw new AppError({
        cause: output.error,
        code: "tool_execution_error",
        details: {
          serverId: this.serverId
        },
        message: `Failed to run MCP server ${this.serverId}.`
      });
    }

    if (output.status !== 0) {
      throw new AppError({
        code: "tool_execution_error",
        details: {
          exitCode: output.status,
          serverId: this.serverId,
          stderr: output.stderr
        },
        message: `MCP server ${this.serverId} exited with status ${output.status}.`
      });
    }

    const messages = parseJsonRpcLines(output.stdout);
    const methodResponse = messages.find((message) => message.id === methodId);
    if (methodResponse === undefined) {
      throw new AppError({
        code: "tool_execution_error",
        details: {
          serverId: this.serverId,
          stdout: output.stdout
        },
        message: `MCP server ${this.serverId} returned no response for ${method}.`
      });
    }

    if (methodResponse.error !== undefined) {
      throw new AppError({
        code: "tool_execution_error",
        details: {
          error: methodResponse.error,
          method,
          serverId: this.serverId
        },
        message: `MCP ${this.serverId}/${method} failed: ${methodResponse.error.message ?? "unknown error"}`
      });
    }

    return methodResponse;
  }

  private requestAsync(
    method: string,
    params: Record<string, unknown>,
    context?: McpInvocationContext
  ): Promise<JsonRpcMessage> {
    const initializeId = 1;
    const methodId = 2;
    const requests = [
      {
        id: initializeId,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          clientInfo: {
            name: "auto-talon",
            version: "phase5"
          },
          protocolVersion: "2024-11-05"
        }
      },
      {
        id: methodId,
        jsonrpc: "2.0",
        method,
        params
      }
    ];
    const input = `${requests.map((item) => JSON.stringify(item)).join("\n")}\n`;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const child = spawn(this.config.command, this.config.args, {
        env: {
          ...process.env,
          ...this.config.env
        },
        stdio: "pipe"
      });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const finishError = (error: AppError): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };
      const finishSuccess = (response: JsonRpcMessage): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(response);
      };
      const timeout = setTimeout(() => {
        child.kill();
        finishError(
          new AppError({
            code: "tool_execution_error",
            details: {
              method,
              serverId: this.serverId
            },
            message: `MCP ${this.serverId}/${method} timed out.`
          })
        );
      }, McpStdioTransport.REQUEST_TIMEOUT_MS);
      const onAbort = (): void => {
        child.kill();
        finishError(
          new AppError({
            code: "interrupt",
            details: {
              method,
              serverId: this.serverId
            },
            message: `MCP ${this.serverId}/${method} aborted.`
          })
        );
      };
      const cleanup = (): void => {
        clearTimeout(timeout);
        context?.signal?.removeEventListener("abort", onAbort);
      };

      context?.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdin.on("error", (error) => {
        finishError(
          new AppError({
            cause: error,
            code: "tool_execution_error",
            details: {
              serverId: this.serverId
            },
            message: `Failed to write request to MCP server ${this.serverId}.`
          })
        );
      });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        finishError(
          new AppError({
            cause: error,
            code: "tool_execution_error",
            details: {
              serverId: this.serverId
            },
            message: `Failed to run MCP server ${this.serverId}.`
          })
        );
      });
      child.on("close", (code) => {
        if (code !== 0) {
          finishError(
            new AppError({
              code: "tool_execution_error",
              details: {
                exitCode: code,
                serverId: this.serverId,
                stderr
              },
              message: `MCP server ${this.serverId} exited with status ${code}.`
            })
          );
          return;
        }
        const messages = parseJsonRpcLines(stdout);
        const methodResponse = messages.find((message) => message.id === methodId);
        if (methodResponse === undefined) {
          finishError(
            new AppError({
              code: "tool_execution_error",
              details: {
                serverId: this.serverId,
                stdout
              },
              message: `MCP server ${this.serverId} returned no response for ${method}.`
            })
          );
          return;
        }
        if (methodResponse.error !== undefined) {
          finishError(
            new AppError({
              code: "tool_execution_error",
              details: {
                error: methodResponse.error,
                method,
                serverId: this.serverId
              },
              message: `MCP ${this.serverId}/${method} failed: ${methodResponse.error.message ?? "unknown error"}`
            })
          );
          return;
        }
        finishSuccess(methodResponse);
      });

      child.stdin.write(input, "utf8");
      child.stdin.end();
    });
  }
}

function parseJsonRpcLines(raw: string): JsonRpcMessage[] {
  return raw
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as JsonRpcMessage;
      } catch {
        return {};
      }
    });
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asJsonObject(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return sanitizeJsonObject(value as Record<string, unknown>);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback?: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new AppError({
    code: "tool_execution_error",
    message: "Invalid MCP response shape."
  });
}

function sanitizeJsonObject(value: Record<string, unknown>): JsonObject {
  const output: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalized = sanitizeJsonValue(entry);
    if (normalized !== undefined) {
      output[key] = normalized;
    }
  }
  return output;
}

function sanitizeJsonValue(value: unknown): JsonValue | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value
      .map((entry) => sanitizeJsonValue(entry))
      .filter((entry): entry is JsonValue => entry !== undefined);
    return items;
  }
  if (typeof value === "object") {
    return sanitizeJsonObject(value as Record<string, unknown>);
  }
  return undefined;
}
