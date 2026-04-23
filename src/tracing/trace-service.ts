import { randomUUID } from "node:crypto";

import type { TraceEvent, TraceEventDraft, TraceRepository } from "../types/index.js";

export class TraceService {
  private readonly listeners = new Set<(event: TraceEvent) => void>();

  public constructor(private readonly traceRepository: TraceRepository) {}

  public record(event: TraceEventDraft): TraceEvent {
    const rest = { ...event };
    delete rest.sequence;

    const persisted = this.traceRepository.append({
      ...rest,
      eventId: event.eventId ?? randomUUID(),
      timestamp: event.timestamp ?? new Date().toISOString()
    });

    for (const listener of this.listeners) {
      listener(persisted);
    }

    return persisted;
  }

  public listByTaskId(taskId: string): TraceEvent[] {
    return this.traceRepository.listByTaskId(taskId);
  }

  public subscribe(listener: (event: TraceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
