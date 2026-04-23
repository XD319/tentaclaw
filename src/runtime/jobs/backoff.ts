import type { ScheduleRecord, ScheduleRunRecord } from "../../types/index.js";

export interface RetryPlan {
  delayMs: number;
  retryAt: string;
}

export function planRetry(
  schedule: Pick<ScheduleRecord, "maxAttempts" | "backoffBaseMs" | "backoffMaxMs">,
  run: Pick<ScheduleRunRecord, "attemptNumber">
): RetryPlan | null {
  if (run.attemptNumber >= schedule.maxAttempts) {
    return null;
  }
  const exponential = schedule.backoffBaseMs * 2 ** Math.max(0, run.attemptNumber - 1);
  const delayMs = Math.min(exponential, schedule.backoffMaxMs);
  return {
    delayMs,
    retryAt: new Date(Date.now() + delayMs).toISOString()
  };
}
