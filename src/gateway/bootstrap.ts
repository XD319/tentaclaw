import type { AppRuntimeHandle, CreateApplicationOptions } from "../runtime";
import { createApplication } from "../runtime";

import { GatewayManager } from "./gateway-manager";
import { GatewayGuard } from "./gateway-guard";
import { FeishuAdapter } from "./feishu/feishu-adapter";
import { resolveFeishuGatewayConfig } from "./feishu/feishu-config";
import { DefaultGatewayIdentityMapper } from "./identity-mapper";
import { LocalWebhookAdapter } from "./local-webhook-adapter";
import { GatewayRuntimeFacade } from "./runtime-facade";
import { RepositoryBackedGatewaySessionMapper } from "./session-mapper";

export function createGatewayRuntime(runtimeHandle: AppRuntimeHandle): GatewayRuntimeFacade {
  return new GatewayRuntimeFacade({
    applicationService: runtimeHandle.service,
    auditService: runtimeHandle.infrastructure.auditService,
    createRunOptions: runtimeHandle.infrastructure.createRunOptions,
    defaultCwd: runtimeHandle.config.workspaceRoot,
    guard: new GatewayGuard({
      cwd: runtimeHandle.config.workspaceRoot
    }),
    identityMapper: new DefaultGatewayIdentityMapper(),
    sessionMapper: new RepositoryBackedGatewaySessionMapper(
      runtimeHandle.infrastructure.storage.gatewaySessions
    ),
    traceService: runtimeHandle.infrastructure.traceService
  });
}

export interface GatewayApplicationHandle {
  close: () => void;
  gateway: GatewayRuntimeFacade;
  runtime: AppRuntimeHandle;
}

export function createGatewayApplication(
  cwd = process.cwd(),
  options: CreateApplicationOptions = {}
): GatewayApplicationHandle {
  const runtime = createApplication(cwd, options);
  return {
    close: () => runtime.close(),
    gateway: createGatewayRuntime(runtime),
    runtime
  };
}

export interface LocalWebhookGatewayHandle {
  adapter: LocalWebhookAdapter;
  manager: GatewayManager;
}

export async function startLocalWebhookGateway(
  runtimeHandle: AppRuntimeHandle,
  options: { host?: string; port: number }
): Promise<LocalWebhookGatewayHandle> {
  const adapterOptions =
    options.host === undefined
      ? { port: options.port }
      : { host: options.host, port: options.port };
  const adapter = new LocalWebhookAdapter(adapterOptions);
  const manager = new GatewayManager(createGatewayRuntime(runtimeHandle), [adapter]);
  await manager.startAll();

  return {
    adapter,
    manager
  };
}

export interface FeishuGatewayHandle {
  adapter: FeishuAdapter;
  manager: GatewayManager;
}

export async function startFeishuGateway(runtimeHandle: AppRuntimeHandle): Promise<FeishuGatewayHandle> {
  const adapter = new FeishuAdapter(resolveFeishuGatewayConfig(runtimeHandle.config.workspaceRoot));
  const manager = new GatewayManager(createGatewayRuntime(runtimeHandle), [adapter]);
  await manager.startAll();
  return { adapter, manager };
}
