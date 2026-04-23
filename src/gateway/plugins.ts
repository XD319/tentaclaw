import type { AppRuntimeHandle } from "../runtime/index.js";
import type { InboundMessageAdapter } from "../types/index.js";

import { FeishuAdapter } from "./feishu/feishu-adapter.js";
import { resolveFeishuGatewayConfig } from "./feishu/feishu-config.js";
import { LocalWebhookAdapter } from "./local-webhook-adapter.js";

export interface GatewayAdapterPlugin {
  createAdapter(runtimeHandle: AppRuntimeHandle): InboundMessageAdapter;
  pluginId: string;
}

export function createLocalWebhookPlugin(options: {
  adapterId?: string;
  host?: string;
  port: number;
}): GatewayAdapterPlugin {
  return {
    createAdapter: () => new LocalWebhookAdapter(options),
    pluginId: "builtin:local-webhook"
  };
}

export function createFeishuGatewayPlugin(): GatewayAdapterPlugin {
  return {
    createAdapter: (runtimeHandle) =>
      new FeishuAdapter(resolveFeishuGatewayConfig(runtimeHandle.config.workspaceRoot)),
    pluginId: "gateway:feishu"
  };
}

