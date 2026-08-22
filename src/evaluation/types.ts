import type { TraceEvent } from "../types/index.js";
import type { EvalSuiteManifest, EvalTask } from "./schema.js";

export type EvalScorerStatus = "passed" | "failed" | "error" | "skipped";

export interface EvalScorerResult {
  evidence: string;
  id: string;
  passed: boolean;
  required: boolean;
  score: number;
  status: EvalScorerStatus;
  type: string;
}

export interface EvalTrialResult {
  arm?: EvalMemoryArm;
  changedPaths: string[];
  costUsd: number | null;
  durationMs: number;
  failureClassification?: EvalFailureClassification | null;
  fixtureTaskId: string;
  hygieneWrites: string[];
  output: string | null;
  recalledTitles: string[];
  rounds: number;
  scorerResults: EvalScorerResult[];
  success: boolean;
  taskId: string;
  tokenUsage: {
    cachedInputTokens: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  toolCallCount: number;
  traceEventCount: number;
  trace: TraceEvent[];
  trial: number;
}

export type EvalFailureClassification =
  | "model_or_contract"
  | "provider_timeout"
  | "provider_configuration_failure"
  | "tool_failure"
  | "environment_failure"
  | "workspace_scope"
  | "verification_failure"
  | "control_flow_failure"
  | "harness_error"
  | "unknown";

export type EvalMemoryArm = "cold" | "warm" | "distractor" | "poisoned";

export interface EvalTaskResult {
  arm?: EvalMemoryArm;
  passAtK: number;
  passPowerK: number;
  successRate: number;
  task: Pick<EvalTask, "id" | "title" | "category" | "difficulty" | "risk" | "capabilities">;
  trials: EvalTrialResult[];
}

export interface EvalSamplingManifest {
  contextWindowTokens: number | null;
  maxRetries: number;
  modelName: string | null;
  streamIdleTimeoutMs: number;
  timeoutMs: number;
}

export interface EvalRunManifest {
  arm?: EvalMemoryArm;
  codeSha: string | null;
  datasetSha256: string;
  generatedAt: string;
  modelName: string | null;
  nodeVersion: string;
  passAtKSize: number;
  platform: string;
  promptVersion: string;
  providerName: string;
  repetitions: number;
  sampling: EvalSamplingManifest;
  suiteId: string;
  suiteVersion: string;
  toolSchemaVersion: string;
}

export interface EvalGroupedMetrics {
  key: string;
  kind: "category" | "capability" | "risk" | "difficulty";
  successRate: number;
  trialCount: number;
}

export interface EvalPairedDelta {
  high: number;
  low: number;
  mean: number;
}

export interface EvalPairedMetrics {
  durationMs: EvalPairedDelta;
  inputTokens: EvalPairedDelta;
  poisonFollowingRate: number | null;
  recallAtK: number | null;
  rounds: EvalPairedDelta;
  toolCallCount: EvalPairedDelta;
}

export interface EvalRunReport {
  gate: {
    passed: boolean;
    reasons: string[];
  };
  manifest: EvalRunManifest;
  metrics: {
    averageRounds: number;
    costUsd: {
      available: boolean;
      average: number | null;
      coverage: number;
      total: number | null;
    };
    averageToolCalls: number;
    durationMs: { p50: number; p95: number };
    grouped: EvalGroupedMetrics[];
    harnessErrorRate: number;
    invalidTrialCount?: number;
    passAtK: number;
    passPowerK: number;
    paired?: EvalPairedMetrics;
    poisonFollowingRate?: number | null;
    providerConfigurationFailureCount?: number;
    recallAtK?: number | null;
    scorableTrialCount: number;
    standardError: number;
    successRate: number;
    successRate95: { high: number; low: number };
    tokenUsage: EvalTrialResult["tokenUsage"] & { available: boolean };
    failureClassificationCounts?: Partial<Record<EvalFailureClassification, number>>;
    providerRecovery?: { attempted: number; recovered: number; successRate: number };
    recoverySuccessRate?: number | null;
    toolFailureOccurrenceRate?: number;
    toolFailureRate?: number;
    toolFailureUnrecoveredRate?: number;
    valid?: boolean;
    verificationCompletionRate?: number | null;
    workspaceScopeViolationRate?: number;
  };
  suite: Pick<EvalSuiteManifest, "id" | "version" | "description">;
  tasks: EvalTaskResult[];
}
