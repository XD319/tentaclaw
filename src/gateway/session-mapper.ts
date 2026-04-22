import { randomUUID } from "node:crypto";

import type {
  GatewaySessionBinding,
  GatewaySessionRepository,
  JsonObject
} from "../types";

export interface GatewaySessionMapper {
  bindTask(params: {
    adapterId: string;
    externalSessionId: string;
    externalUserId: string | null;
    metadata: JsonObject;
    runtimeUserId: string;
    taskId: string;
  }): GatewaySessionBinding;
  resolveContinuation(params: {
    adapterId: string;
    externalSessionId: string;
  }): { previousTaskId: string; runtimeUserId: string } | null;
  findByTaskId(taskId: string): GatewaySessionBinding | null;
}

export class RepositoryBackedGatewaySessionMapper implements GatewaySessionMapper {
  public constructor(private readonly repository: GatewaySessionRepository) {}

  public bindTask(params: {
    adapterId: string;
    externalSessionId: string;
    externalUserId: string | null;
    metadata: JsonObject;
    runtimeUserId: string;
    taskId: string;
  }): GatewaySessionBinding {
    return this.repository.create({
      adapterId: params.adapterId,
      externalSessionId: params.externalSessionId,
      externalUserId: params.externalUserId,
      metadata: params.metadata,
      runtimeUserId: params.runtimeUserId,
      sessionBindingId: randomUUID(),
      taskId: params.taskId
    });
  }

  public findByTaskId(taskId: string): GatewaySessionBinding | null {
    return this.repository.findByTaskId(taskId);
  }

  public resolveContinuation(params: {
    adapterId: string;
    externalSessionId: string;
  }): { previousTaskId: string; runtimeUserId: string } | null {
    const latest = this.repository.findLatestByExternalSession(
      params.adapterId,
      params.externalSessionId
    );
    if (latest === null) {
      return null;
    }
    return {
      previousTaskId: latest.taskId,
      runtimeUserId: latest.runtimeUserId
    };
  }
}
