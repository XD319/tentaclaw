import type { JsonObject } from "./common.js";

export interface GatewaySessionBindingDraft {
  adapterId: string;
  externalSessionId: string;
  externalUserId: string | null;
  metadata: JsonObject;
  runtimeUserId: string;
  sessionBindingId: string;
  taskId: string;
}
