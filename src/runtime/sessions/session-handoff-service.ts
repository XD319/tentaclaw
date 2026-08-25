import { randomUUID } from "node:crypto";

import type {
  GatewaySessionBinding,
  GatewaySessionRepository,
  JsonObject,
  SessionRecord,
  SessionRepository
} from "../../types/index.js";

export interface SessionHandoffRequest {
  adapterId: string;
  externalSessionId: string;
  externalUserId?: string | null;
  metadata?: JsonObject;
  ownerUserId: string;
  runtimeSessionId: string;
  runtimeUserId: string;
  source: "cli" | "gateway" | "tui" | "web";
}

export interface SessionHandoffResult {
  binding: GatewaySessionBinding;
  resumeHint: string;
  runtimeSessionId: string;
  session: SessionRecord;
}

export interface SessionHandoffServiceDependencies {
  gatewaySessionRepository: GatewaySessionRepository;
  sessionRepository: SessionRepository;
}

export class SessionHandoffService {
  public constructor(private readonly dependencies: SessionHandoffServiceDependencies) {}

  public handoff(request: SessionHandoffRequest): SessionHandoffResult {
    const session = this.dependencies.sessionRepository.findById(request.runtimeSessionId);
    if (session === null) {
      throw new Error(`Session ${request.runtimeSessionId} was not found.`);
    }
    if (session.ownerUserId !== request.ownerUserId) {
      throw new Error(`Session ${request.runtimeSessionId} does not belong to ${request.ownerUserId}.`);
    }

    const binding = this.dependencies.gatewaySessionRepository.create({
      adapterId: request.adapterId,
      externalSessionId: request.externalSessionId,
      externalUserId: request.externalUserId ?? null,
      metadata: {
        ...(request.metadata ?? {}),
        handoffSource: request.source,
        handoffAt: new Date().toISOString()
      },
      runtimeSessionId: request.runtimeSessionId,
      runtimeUserId: request.runtimeUserId,
      sessionBindingId: randomUUID(),
      taskId: `handoff:${randomUUID()}`
    });

    return {
      binding,
      resumeHint: `talon tui --resume ${request.runtimeSessionId}`,
      runtimeSessionId: request.runtimeSessionId,
      session
    };
  }

  public rebindExternalSession(input: {
    adapterId: string;
    externalSessionId: string;
    externalUserId?: string | null;
    metadata?: JsonObject;
    ownerUserId: string;
    runtimeSessionId: string;
    runtimeUserId: string;
  }): SessionHandoffResult {
    return this.handoff({
      adapterId: input.adapterId,
      externalSessionId: input.externalSessionId,
      externalUserId: input.externalUserId ?? null,
      metadata: {
        ...(input.metadata ?? {}),
        rebind: true
      },
      ownerUserId: input.ownerUserId,
      runtimeSessionId: input.runtimeSessionId,
      runtimeUserId: input.runtimeUserId,
      source: "gateway"
    });
  }

  public listBindingsForSession(runtimeSessionId: string): GatewaySessionBinding[] {
    return this.dependencies.gatewaySessionRepository.listByRuntimeSessionId(runtimeSessionId);
  }
}
