import { loadSmokeTaskFixtures } from "../testing/smoke-fixtures.js";
import { runSmokeSuite } from "../testing/smoke-harness.js";
import type { SupportedProviderName } from "../providers/index.js";

export interface EvalReport {
  averageDurationMs: number;
  averageRounds: number;
  categorySuccessRates: Record<string, {
    succeeded: number;
    successRate: number;
    total: number;
  }>;
  failureReasonDistribution: Record<string, number>;
  modelName: string | null;
  providerName: string;
  successRate: number;
  taskCount: number;
  tokenUsage: {
    available: boolean;
    averageCachedInputTokens: number;
    averageInputTokens: number;
    averageOutputTokens: number;
    averageTotalTokens: number;
    totalCachedInputTokens: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
  };
  typicalFailures: Array<{
    failureReason: string;
    taskFixtureId: string;
    taskId: string;
  }>;
}

export interface EvalOptions {
  fixturePath?: string;
  providerName?: SupportedProviderName | "scripted-smoke";
  taskIds?: string[];
}

export async function runEvalReport(options: EvalOptions = {}): Promise<EvalReport> {
  const fixtures = loadSmokeTaskFixtures(options.fixturePath);
  const selectedTaskIds =
    options.taskIds === undefined || options.taskIds.length === 0
      ? fixtures.map((fixture) => fixture.taskId)
      : options.taskIds;

  const report = await runSmokeSuite({
    autoApprove: true,
    ...(options.fixturePath !== undefined
      ? { fixturePath: options.fixturePath }
      : {}),
    providerName: options.providerName ?? "scripted-smoke",
    taskIds: selectedTaskIds
  });

  const totalTokens = report.results.reduce(
    (accumulator, result) => ({
      cachedInputTokens: accumulator.cachedInputTokens + result.tokenUsage.cachedInputTokens,
      inputTokens: accumulator.inputTokens + result.tokenUsage.inputTokens,
      outputTokens: accumulator.outputTokens + result.tokenUsage.outputTokens,
      totalTokens: accumulator.totalTokens + result.tokenUsage.totalTokens
    }),
    {
      cachedInputTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    }
  );
  const tokenAvailable = report.results.some((result) => result.tokenUsage.totalTokens > 0);
  const taskCount = report.taskCount;
  const categorySuccessRates = report.results.reduce<Record<string, {
    succeeded: number;
    successRate: number;
    total: number;
  }>>((categories, result) => {
    const category = result.taskFixture.category;
    const current = categories[category] ?? {
      succeeded: 0,
      successRate: 0,
      total: 0
    };
    current.total += 1;
    if (result.success) {
      current.succeeded += 1;
    }
    current.successRate = current.total === 0 ? 0 : current.succeeded / current.total;
    categories[category] = current;
    return categories;
  }, {});

  return {
    averageDurationMs: report.averageDurationMs,
    averageRounds: report.averageRounds,
    categorySuccessRates,
    failureReasonDistribution: report.failureReasons,
    modelName: report.modelName,
    providerName: report.providerName,
    successRate: taskCount === 0 ? 0 : report.succeededCount / taskCount,
    taskCount,
    tokenUsage: {
      available: tokenAvailable,
      averageCachedInputTokens: taskCount === 0 ? 0 : totalTokens.cachedInputTokens / taskCount,
      averageInputTokens: taskCount === 0 ? 0 : totalTokens.inputTokens / taskCount,
      averageOutputTokens: taskCount === 0 ? 0 : totalTokens.outputTokens / taskCount,
      averageTotalTokens: taskCount === 0 ? 0 : totalTokens.totalTokens / taskCount,
      totalCachedInputTokens: totalTokens.cachedInputTokens,
      totalInputTokens: totalTokens.inputTokens,
      totalOutputTokens: totalTokens.outputTokens,
      totalTokens: totalTokens.totalTokens
    },
    typicalFailures: report.results
      .filter((result) => !result.success && result.failureReason !== null)
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, 5)
      .map((result) => ({
        failureReason: result.failureReason ?? "unknown_failure",
        taskFixtureId: result.taskFixture.taskId,
        taskId: result.taskId
      }))
  };
}
