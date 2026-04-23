import { randomUUID } from "node:crypto";

import type { AuditLogDraft, AuditLogRecord, AuditLogRepository } from "../types/index.js";

export class AuditService {
  private readonly listeners = new Set<(event: AuditLogRecord) => void>();

  public constructor(private readonly auditLogRepository: AuditLogRepository) {}

  public record(
    event: Omit<AuditLogDraft, "auditId" | "createdAt"> &
      Partial<Pick<AuditLogDraft, "auditId" | "createdAt">>
  ): AuditLogRecord {
    const persisted = this.auditLogRepository.append({
      ...event,
      auditId: event.auditId ?? randomUUID(),
      createdAt: event.createdAt ?? new Date().toISOString()
    });

    for (const listener of this.listeners) {
      listener(persisted);
    }

    return persisted;
  }

  public listByTaskId(taskId: string): AuditLogRecord[] {
    return this.auditLogRepository.listByTaskId(taskId);
  }

  public subscribe(listener: (event: AuditLogRecord) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
