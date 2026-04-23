import type { TraceEvent } from "../types/index.js";

export function formatTraceEvent(event: TraceEvent): string {
  const headline = `#${event.sequence} ${event.timestamp} [${event.stage}] ${event.eventType}`;
  const detail = `${event.actor} - ${event.summary}`;
  const payload = JSON.stringify(event.payload, null, 2);

  return `${headline}\n${detail}\n${payload}`;
}
