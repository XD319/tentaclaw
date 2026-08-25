import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";

import { AppError } from "./app-error.js";
import { resolveWorkspaceLayout } from "../runtime/workspace-layout.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
let missingHttpTokenWarningEmitted = false;

export function isHttpAuthDisabled(): boolean {
  return process.env.AGENT_HTTP_INSECURE === "1";
}

export function collectHttpAuthDoctorIssues(cwd: string): string[] {
  if (isHttpAuthDisabled()) {
    return [];
  }
  const token = resolveHttpAuthToken(cwd);
  if (token === null) {
    return [
      "Local HTTP services are running without authentication because AGENT_HTTP_TOKEN and .auto-talon/http.token are missing. Run talon init or set AGENT_HTTP_TOKEN."
    ];
  }
  return [];
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(normalized)) {
    return true;
  }
  if (normalized === "0.0.0.0" || normalized === "::") {
    return false;
  }
  return normalized.startsWith("127.");
}

export function resolveHttpAuthToken(cwd: string): string | null {
  const fromEnv = process.env.AGENT_HTTP_TOKEN?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  const tokenPath = join(resolveWorkspaceLayout(cwd).stateRoot, "http.token");
  if (!existsSync(tokenPath)) {
    return null;
  }
  const fromFile = readFileSync(tokenPath, "utf8").trim();
  return fromFile.length > 0 ? fromFile : null;
}

export function readBearerToken(authorizationHeader: string | undefined): string | null {
  if (authorizationHeader === undefined) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/iu.exec(authorizationHeader.trim());
  if (match === null) {
    return null;
  }
  const token = match[1]?.trim();
  return token !== undefined && token.length > 0 ? token : null;
}

export const TALON_HTTP_COOKIE_NAME = "talon_http";

export function validateHttpBearerAuth(
  authorizationHeader: string | undefined,
  expectedToken: string | null
): boolean {
  if (expectedToken === null) {
    return true;
  }
  const provided = readBearerToken(authorizationHeader);
  return provided === expectedToken;
}

export function readCookieValue(cookieHeader: string | undefined, cookieName: string): string | null {
  if (cookieHeader === undefined || cookieHeader.trim().length === 0) {
    return null;
  }
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (name !== cookieName) {
      continue;
    }
    const raw = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

export function buildHttpAuthSetCookie(token: string): string {
  return `${TALON_HTTP_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`;
}

export function validateHttpCookieAuth(
  cookieHeader: string | undefined,
  expectedToken: string | null
): boolean {
  if (expectedToken === null) {
    return true;
  }
  const provided = readCookieValue(cookieHeader, TALON_HTTP_COOKIE_NAME);
  return provided === expectedToken;
}

export function assertSafeHttpBind(input: {
  cwd: string;
  host: string;
  insecure?: boolean;
}): string | null {
  const token = resolveHttpAuthToken(input.cwd);
  if (isLoopbackHost(input.host)) {
    return token;
  }
  if (input.insecure === true) {
    return token;
  }
  if (token === null) {
    throw new AppError({
      code: "invalid_state",
      message:
        `Refusing to bind HTTP service to non-loopback host ${input.host} without authentication. ` +
        "Set AGENT_HTTP_TOKEN or create .auto-talon/http.token, or pass --insecure to override."
    });
  }
  return token;
}

export function requireHttpAuth(
  request: IncomingMessage,
  cwd: string
): { authorized: true } | { authorized: false; message: string } {
  if (isHttpAuthDisabled()) {
    return { authorized: true };
  }
  const token = resolveHttpAuthToken(cwd);
  if (token === null) {
    if (!missingHttpTokenWarningEmitted) {
      missingHttpTokenWarningEmitted = true;
      console.warn(
        "Warning: local HTTP services are accepting unauthenticated requests because no AGENT_HTTP_TOKEN or .auto-talon/http.token is configured."
      );
    }
    return { authorized: true };
  }
  const header = (request.headers as Record<string, unknown>).authorization;
  const headerValue =
    typeof header === "string"
      ? header
      : Array.isArray(header) && typeof header[0] === "string"
        ? header[0]
        : undefined;
  if (validateHttpBearerAuth(headerValue, token)) {
    return { authorized: true };
  }
  const cookieHeader = (request.headers as Record<string, unknown>).cookie;
  const cookieValue =
    typeof cookieHeader === "string"
      ? cookieHeader
      : Array.isArray(cookieHeader) && typeof cookieHeader[0] === "string"
        ? cookieHeader[0]
        : undefined;
  if (validateHttpCookieAuth(cookieValue, token)) {
    return { authorized: true };
  }
  return {
    authorized: false,
    message: "Missing or invalid Authorization: Bearer token."
  };
}

export function createGatewayAuthHook(cwd: string): (input: {
  adapterId: string;
  request: { metadata?: Record<string, unknown> };
}) => boolean {
  const token = resolveHttpAuthToken(cwd);
  if (token === null) {
    return () => true;
  }
  return (input) => {
    const metadata = input.request.metadata;
    const authHeader =
      typeof metadata?.authorization === "string"
        ? metadata.authorization
        : typeof metadata?.authToken === "string"
          ? `Bearer ${metadata.authToken}`
          : undefined;
    return validateHttpBearerAuth(authHeader, token);
  };
}
