import { AppError } from "./app-error";

export type AbortReason = "interrupt" | "timeout";

export interface ManagedAbortController {
  abortController: AbortController;
  dispose: () => void;
  getReason: () => AbortReason | null;
}

export function createManagedAbortController(
  timeoutMs: number,
  upstreamSignal?: AbortSignal
): ManagedAbortController {
  const abortController = new AbortController();
  let reason: AbortReason | null = null;

  const abort = (nextReason: AbortReason): void => {
    if (!abortController.signal.aborted) {
      reason = nextReason;
      abortController.abort(nextReason);
    }
  };

  const timeout = setTimeout(() => abort("timeout"), timeoutMs);

  const onAbort = (): void => {
    abort("interrupt");
  };

  upstreamSignal?.addEventListener("abort", onAbort);

  return {
    abortController,
    dispose: () => {
      clearTimeout(timeout);
      upstreamSignal?.removeEventListener("abort", onAbort);
    },
    getReason: () => reason
  };
}

export function throwIfAborted(signal: AbortSignal, reason: AbortReason | null): void {
  if (signal.aborted) {
    throw new AppError({
      code: reason === "timeout" ? "timeout" : "interrupt",
      message: reason === "timeout" ? "Task timed out." : "Task interrupted by signal."
    });
  }
}
