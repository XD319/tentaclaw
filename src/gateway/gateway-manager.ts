import type { AdapterCapabilityName, GatewayRuntimeApi, InboundMessageAdapter } from "../types/index.js";
import type { OutboundResponseAdapter } from "../types/index.js";

const ALL_CAPABILITIES: AdapterCapabilityName[] = [
  "textInteraction",
  "approvalInteraction",
  "fileCapability",
  "attachmentCapability",
  "streamingCapability",
  "structuredCardCapability"
];

export interface GatewayManagerOptions {
  requiredCapabilitiesByAdapter?: Partial<
    Record<string, Partial<Record<AdapterCapabilityName, boolean>>>
  >;
}

export class GatewayManager {
  public constructor(
    private readonly runtimeApi: GatewayRuntimeApi,
    private readonly adapters: InboundMessageAdapter[],
    private readonly options: GatewayManagerOptions = {}
  ) {}

  public async startAll(): Promise<void> {
    for (const adapter of this.adapters) {
      if (!adapter.descriptor.capabilities.textInteraction.supported) {
        throw new Error(
          `Adapter ${adapter.descriptor.adapterId} cannot start without textInteraction support.`
        );
      }
      for (const capabilityName of ALL_CAPABILITIES) {
        const declared = adapter.descriptor.capabilities[capabilityName];
        if (declared === undefined || typeof declared.supported !== "boolean") {
          throw new Error(
            `Adapter ${adapter.descriptor.adapterId} must declare ${capabilityName} capability explicitly.`
          );
        }
      }
      this.assertRequiredCapabilities(adapter);
      if (
        adapter.descriptor.adapterId.length > 0 &&
        (typeof (adapter as { sendEvent?: unknown }).sendEvent === "function" ||
          typeof (adapter as { sendResult?: unknown }).sendResult === "function" ||
          typeof (adapter as { sendCapabilityNotice?: unknown }).sendCapabilityNotice === "function")
      ) {
        this.runtimeApi.registerOutboundAdapter(
          adapter.descriptor.adapterId,
          adapter as unknown as OutboundResponseAdapter
        );
      }

      adapter.descriptor.lifecycleState = "starting";
      await adapter.start({
        runtimeApi: this.runtimeApi
      });
      adapter.descriptor.lifecycleState = "running";
    }
  }

  public async stopAll(): Promise<void> {
    for (const adapter of this.adapters) {
      await adapter.stop();
      adapter.descriptor.lifecycleState = "stopped";
    }
  }

  public listAdapters(): InboundMessageAdapter[] {
    return [...this.adapters];
  }

  private assertRequiredCapabilities(adapter: InboundMessageAdapter): void {
    const required =
      this.options.requiredCapabilitiesByAdapter?.[adapter.descriptor.adapterId] ?? {};

    for (const capabilityName of ALL_CAPABILITIES) {
      if (required[capabilityName] !== true) {
        continue;
      }
      if (!adapter.descriptor.capabilities[capabilityName].supported) {
        throw new Error(
          `Adapter ${adapter.descriptor.adapterId} must support required capability ${capabilityName}.`
        );
      }
    }
  }
}
