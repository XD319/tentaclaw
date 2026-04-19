import { randomUUID } from "node:crypto";
import React from "react";
import { render } from "ink";

import { createApplication } from "../runtime";

import { ChatTuiApp } from "./chat-app";
import { AgentTuiApp } from "./dashboard-app";
import type { ChatMessage } from "./view-models/chat-messages";
import { loadSession } from "./session-store";
import { RuntimeDashboardQueryService } from "./view-models/runtime-dashboard";

export interface StartTuiOptions {
  cwd?: string;
  resumeSessionId?: string;
}

export async function startTui(options: StartTuiOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const handle = createApplication(cwd);
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

export async function startDashboardTui(cwd = process.cwd()): Promise<void> {
  const handle = createApplication(cwd);
  try {
    const app = render(
      React.createElement(AgentTuiApp, {
        queryService: new RuntimeDashboardQueryService(handle.service),
        reviewerId: process.env.USERNAME ?? process.env.USER ?? "local-reviewer"
      })
    );
    await app.waitUntilExit();
    app.unmount();
  } finally {
    handle.close();
  }
}
