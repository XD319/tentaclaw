import type { GatewayIdentityBinding, GatewayRequesterIdentity } from "../types";

export interface GatewayIdentityMapper {
  bind(adapterId: string, requester: GatewayRequesterIdentity): GatewayIdentityBinding;
}

export class DefaultGatewayIdentityMapper implements GatewayIdentityMapper {
  public bind(adapterId: string, requester: GatewayRequesterIdentity): GatewayIdentityBinding {
    const normalizedUserId =
      requester.externalUserId === null || requester.externalUserId.trim().length === 0
        ? `${adapterId}:session:${requester.externalSessionId}`
        : `${adapterId}:${requester.externalUserId.trim()}`;

    return {
      adapterId,
      externalUserId: requester.externalUserId,
      runtimeUserId: normalizedUserId
    };
  }
}
