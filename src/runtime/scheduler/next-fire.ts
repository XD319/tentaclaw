import { CronExpressionParser } from "cron-parser";

import type { ScheduleRecord } from "../../types/index.js";

const EVERY_RE = /^(\d+)\s*(ms|s|m|h|d)$/i;

const MULTIPLIERS: Record<string, number> = {
  d: 24 * 60 * 60 * 1000,
  h: 60 * 60 * 1000,
  m: 60 * 1000,
  ms: 1,
  s: 1000
};

export function parseEveryExpression(value: string): number {
  const match = EVERY_RE.exec(value.trim());
  const amountPart = match?.[1];
  const unitPart = match?.[2];
  if (amountPart === undefined || unitPart === undefined) {
    throw new Error(`Invalid every expression: ${value}`);
  }
  const amount = Number.parseInt(amountPart, 10);
  const unit = unitPart.toLowerCase();
  const multiplier = MULTIPLIERS[unit];
  if (!Number.isFinite(amount) || amount <= 0 || multiplier === undefined) {
    throw new Error(`Invalid every expression: ${value}`);
  }
  return amount * multiplier;
}

export function computeNextFireAt(schedule: Pick<ScheduleRecord, "cron" | "intervalMs" | "timezone">, from: Date): Date | null {
  if (schedule.cron !== null) {
    const interval = CronExpressionParser.parse(schedule.cron, {
      currentDate: from,
      ...(schedule.timezone !== null ? { tz: schedule.timezone } : {})
    });
    return interval.next().toDate();
  }
  if (schedule.intervalMs !== null) {
    return new Date(from.getTime() + schedule.intervalMs);
  }
  return null;
}
