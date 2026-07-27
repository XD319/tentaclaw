import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { AppError } from "./app-error.js";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal"
]);

export function validateOutboundUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw denied(`Invalid outbound URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw denied(`Outbound URL must use http or https: ${rawUrl}`);
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (BLOCKED_HOSTNAMES.has(hostname) || isBlockedAddress(hostname)) {
    throw denied(`Outbound URL hostname is blocked: ${hostname}`);
  }
  return parsed;
}

/** Resolves every address before delivery so public hostnames cannot point at internal services. */
export interface ResolvedOutboundTarget {
  address: string;
  family: 4 | 6;
  url: URL;
}

export async function resolvePublicOutboundTarget(rawUrl: string): Promise<ResolvedOutboundTarget> {
  const parsed = validateOutboundUrl(rawUrl);
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, "");
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    return { address: hostname, family: literalFamily as 4 | 6, url: parsed };
  }
  let addresses: Awaited<ReturnType<typeof lookup>>[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw denied(`Outbound URL hostname could not be resolved: ${hostname}`);
  }
  if (addresses.length === 0 || addresses.some((address) => isBlockedAddress(address.address))) {
    throw denied(`Outbound URL resolves to a blocked network address: ${hostname}`);
  }
  const address = addresses[0];
  if (address === undefined) {
    throw denied(`Outbound URL hostname could not be resolved: ${hostname}`);
  }
  return { address: address.address, family: address.family as 4 | 6, url: parsed };
}

function denied(message: string): AppError {
  return new AppError({ code: "sandbox_denied", message });
}

function isBlockedAddress(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "::1" || normalized === "::" || normalized === "0.0.0.0") {
    return true;
  }
  if (isIPv4MappedIpv6(normalized)) {
    return true;
  }
  if (isIP(normalized) === 6) {
    return (
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80") ||
      normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8")
    );
  }
  return isBlockedIpv4(normalized);
}

function isIPv4MappedIpv6(value: string): boolean {
  if (!value.startsWith("::ffff:")) {
    return false;
  }
  const mapped = value.slice("::ffff:".length);
  return isBlockedIpv4(mapped) || mapped.includes(":");
}

function isBlockedIpv4(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname);
  if (match === null) {
    return false;
  }
  const octets = match.slice(1).map((value) => Number.parseInt(value, 10));
  if (octets.some((octet) => octet > 255)) {
    return true;
  }
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 2 || b === 88 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}
