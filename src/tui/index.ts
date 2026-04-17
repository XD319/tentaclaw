import React from "react";
import { render } from "ink";

import { createApplication } from "../runtime";

import { AgentTuiApp } from "./app";
import { RuntimeDashboardQueryService } from "./view-models/runtime-dashboard";

export async function startTui(cwd = process.cwd()): Promise<void> {
  const handle = createApplication(cwd);
  const app = render(
    React.createElement(AgentTuiApp, {
      queryService: new RuntimeDashboardQueryService(handle.service),
      reviewerId: process.env.USERNAME ?? process.env.USER ?? "local-reviewer"
    })
  );

  try {
    await app.waitUntilExit();
  } finally {
    app.unmount();
    handle.close();
  }
}

if (require.main === module) {
  void startTui();
}
