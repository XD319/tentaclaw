import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";

import { buildHttpAuthSetCookie, resolveHttpAuthToken } from "../core/http-auth.js";

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2"
};

const FALLBACK_INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AutoTalon</title>
  </head>
  <body>
    <main>
      <h1>AutoTalon</h1>
      <p>Web workspace is starting. Rebuild with <code>npm run build</code> if this page stays empty.</p>
    </main>
  </body>
</html>
`;

export function resolveWebAssetRoot(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [join(here, "../web"), join(here, "../../dist/web"), join(here, "../../web/dist")];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) {
      return candidate;
    }
  }
  return candidates[0] ?? join(here, "../web");
}

export function tryServeWebAsset(
  pathname: string,
  cwd: string,
  response: ServerResponse
): boolean {
  const root = resolveWebAssetRoot();
  const requestPath = pathname === "/" ? "/index.html" : pathname;
  const relative = normalize(requestPath).replace(/^[/\\]+/u, "");
  const absolute = resolve(root, relative);
  if (!absolute.startsWith(resolve(root) + sep) && absolute !== resolve(root)) {
    return false;
  }
  const isIndex = requestPath === "/index.html";
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    if (!isIndex) {
      return false;
    }
    writeIndex(response, cwd, FALLBACK_INDEX);
    return true;
  }
  const body = readFileSync(absolute);
  const contentType = MIME_TYPES[extname(absolute)] ?? "application/octet-stream";
  if (isIndex) {
    writeIndex(response, cwd, body.toString("utf8"));
    return true;
  }
  response.statusCode = 200;
  response.setHeader("content-type", contentType);
  response.end(body);
  return true;
}

function writeIndex(response: ServerResponse, cwd: string, html: string): void {
  const token = resolveHttpAuthToken(cwd);
  response.statusCode = 200;
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (token !== null) {
    response.setHeader("set-cookie", buildHttpAuthSetCookie(token));
  }
  response.end(html);
}
