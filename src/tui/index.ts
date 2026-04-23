import { randomUUID } from "node:crypto";
import React from "react";
import { render } from "ink";

import { createApplication } from "../runtime/index.js";
import type { ResolveAppConfigOptions } from "../runtime/index.js";

import { ChatTuiApp } from "./chat-app.js";
import { AgentTuiApp } from "./dashboard-app.js";
import type { ChatMessage } from "./view-models/chat-messages.js";
import { loadSession } from "./session-store.js";
import { RuntimeDashboardQueryService } from "./view-models/runtime-dashboard.js";

export interface StartTuiOptions {
  cwd?: string;
  resumeSessionId?: string;
  sandbox?: ResolveAppConfigOptions;
}

export async function startTui(options: StartTuiOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const handle = createApplication(cwd, {
    ...(options.sandbox !== undefined ? { sandbox: options.sandbox } : {})
  });
  try {
    const sessionId = options.resumeSessionId ?? randomUUID();
    let initialMessages = undefined;
    if (options.resumeSessionId !== undefined) {
      const loaded = await loadSession(handle.config.workspaceRoot, options.resumeSessionId);
      const missing: ChatMessage[] = [
        {
          id: "system:resume-missing",
          kind: "system",
          text: `Session file not found for id ${options.resumeSessionId}. Starting a new transcript with this id.`,
          timestamp: new Date().toISOString()
        }
      ];
      initialMessages = loaded?.messages ?? missing;
    }

    const app = render(
      React.createElement(ChatTuiApp, {
        config: handle.config,
        cwd,
        ...(initialMessages !== undefined ? { initialMessages } : {}),
        initialSessionId: sessionId,
        reviewerId: process.env.USERNAME ?? process.env.USER ?? "local-reviewer",
        service: handle.service
      }),
      {
        exitOnCtrlC: false
      }
    );
    await app.waitUntilExit();
    app.unmount();
  } finally {
    handle.close();
  }
}

export async function startDashboardTui(
  cwd = process.cwd(),
  sandbox?: ResolveAppConfigOptions
): Promise<void> {
  const handle = createApplication(cwd, {
    ...(sandbox !== undefined ? { sandbox } : {})
  });
  try {
    const app = render(
      React.createElement(AgentTuiApp, {
        queryService: new RuntimeDashboardQueryService(handle.service),
        reviewerId: process.env.USERNAME ?? process.env.USER ?? "local-reviewer"
      }),
      {
        exitOnCtrlC: false
      }
    );
    await app.waitUntilExit();
    app.unmount();
  } finally {
    handle.close();
  }
}
