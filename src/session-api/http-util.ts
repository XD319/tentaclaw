import type { IncomingMessage, ServerResponse } from "node:http";

export function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

export function writeText(
  response: ServerResponse,
  statusCode: number,
  body: string,
  contentType: string,
  extraHeaders?: Record<string, string>
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", contentType);
  if (extraHeaders !== undefined) {
    for (const [name, value] of Object.entries(extraHeaders)) {
      response.setHeader(name, value);
    }
  }
  response.end(body);
}

export async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const value: unknown = chunk;
    if (typeof value === "string") {
      chunks.push(Buffer.from(value));
    } else if (Buffer.isBuffer(value)) {
      chunks.push(value);
    } else if (value instanceof Uint8Array) {
      chunks.push(Buffer.from(value));
    }
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function optionalField<K extends string>(
  key: K,
  value: string | undefined
): Record<K, string> | Record<string, never> {
  if (value === undefined) {
    return {};
  }
  return { [key]: value } as Record<K, string>;
}

export function matchPath(
  pathname: string,
  pattern: RegExp
): RegExpMatchArray | null {
  return pathname.match(pattern);
}
