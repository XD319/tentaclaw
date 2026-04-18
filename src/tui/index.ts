import React from "react";
import { render } from "ink";

import { createApplication } from "../runtime";

import { ChatTuiApp } from "./chat-app";
import { AgentTuiApp } from "./dashboard-app";
import { RuntimeDashboardQueryService } from "./view-models/runtime-dashboard";

export async function startTui(cwd = process.cwd()): Promise<void> {
  const handle = createApplication(cwd);
  try {
    const app = render(
      React.createElement(ChatTuiApp, {
        config: handle.config,
        cwd,
        reviewerId: process.env.USERNAME ?? process.env.USER ?? "local-reviewer",
        service: handle.service
      })
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
