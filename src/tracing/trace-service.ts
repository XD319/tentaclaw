import { randomUUID } from "node:crypto";

import type { TraceEvent, TraceEventDraft, TraceRepository } from "../types";

export class TraceService {
  public constructor(private readonly traceRepository: TraceRepository) {}

  public record(event: TraceEventDraft): TraceEvent {
    const rest = { ...event };
    delete rest.sequence;

    return this.traceRepository.append({
      ...rest,
      eventId: event.eventId ?? randomUUID(),
      timestamp: event.timestamp ?? new Date().toISOString()
    });
  }

  public listByTaskId(taskId: string): TraceEvent[] {
    return this.traceRepository.listByTaskId(taskId);
  }
}
