import { execFile } from "node:child_process";

import { assertSafeHttpBind } from "../core/http-auth.js";
import { createApplication } from "../runtime/bootstrap.js";
import { initializeWorkspaceFiles } from "../runtime/workspace-setup.js";
import { startSessionApiServer } from "../session-api/server.js";

export interface LaunchWebUiOptions {
  cwd: string;
  host?: string;
  insecure?: boolean;
  open?: boolean;
  port?: number;
}

export interface StartedWebUi {
  close: () => Promise<void>;
  url: string;
}

export async function startWebUi(options: LaunchWebUiOptions): Promise<StartedWebUi> {
  const cwd = options.cwd;
  const host = options.host ?? "127.0.0.1";
  initializeWorkspaceFiles(cwd);
  assertSafeHttpBind({ cwd, host, insecure: options.insecure === true });
  const handle = createApplication(cwd, { scheduler: { autoStart: true } });
  const port = options.port ?? 7080;
  try {
    const started = await startSessionApiServer({
      cwd,
      host,
      port,
      service: handle.service
    });
    return {
      close: async () => {
        await started.close();
        handle.close();
      },
      url: started.url
    };
  } catch (error) {
    handle.close();
    throw error;
  }
}

export async function launchWebUi(options: LaunchWebUiOptions): Promise<void> {
  const started = await startWebUi(options);
  console.log(`Web UI listening at ${started.url}`);
  if (options.open !== false) {
    openBrowser(started.url);
  }
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  await started.close();
}

function openBrowser(url: string): void {
  const onError = (error: Error): void => {
    console.error(`Could not open browser automatically. Open ${url} manually. (${error.message})`);
  };
  if (process.platform === "win32") {
    execFile("cmd", ["/c", "start", "", url], { windowsHide: true }, (error) => {
      if (error !== null) {
        onError(error);
      }
    });
    return;
  }
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  execFile(command, [url], (error) => {
    if (error !== null) {
      onError(error);
    }
  });
}
