export type StatusTone = "accent" | "danger" | "muted" | "neutral" | "success" | "warn";

export type UiRunState =
  | "failed"
  | "idle"
  | "interrupted"
  | "running"
  | "succeeded"
  | "waiting_approval";

export interface UiStatus {
  approvalLabel: string | null;
  primaryLabel: string;
  primaryTone: StatusTone;
  runState: UiRunState;
  taskLabel: string | null;
}
