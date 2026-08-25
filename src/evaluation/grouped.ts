import type { EvalGroupedMetrics, EvalTaskResult } from "./types.js";

export function collectGroupedMetrics(tasks: EvalTaskResult[]): EvalGroupedMetrics[] {
  const buckets = new Map<string, { kind: EvalGroupedMetrics["kind"]; successes: number; trials: number }>();
  const add = (kind: EvalGroupedMetrics["kind"], key: string, successes: number, trials: number) => {
    const id = `${kind}:${key}`;
    const current = buckets.get(id) ?? { kind, successes: 0, trials: 0 };
    current.successes += successes;
    current.trials += trials;
    buckets.set(id, current);
  };
  for (const task of tasks) {
    const successes = task.trials.filter((trial) => trial.success).length;
    const trials = task.trials.length;
    add("category", task.task.category, successes, trials);
    add("risk", task.task.risk, successes, trials);
    add("difficulty", task.task.difficulty, successes, trials);
    for (const capability of task.task.capabilities) {
      add("capability", capability, successes, trials);
    }
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, bucket]) => ({
      key: id.slice(id.indexOf(":") + 1),
      kind: bucket.kind,
      successRate: bucket.trials === 0 ? 0 : bucket.successes / bucket.trials,
      trialCount: bucket.trials
    }));
}

export function difficultyCalibrationWarnings(tasks: EvalTaskResult[]): string[] {
  const warnings: string[] = [];
  for (const task of tasks) {
    if (task.task.difficulty === "easy" && task.successRate === 0) {
      warnings.push(`easy task never passed: ${task.task.id}`);
    }
    if (task.task.difficulty === "hard" && task.successRate === 1) {
      warnings.push(`hard task always passed: ${task.task.id}`);
    }
  }
  return warnings;
}

export function taskFlipList(
  current: EvalTaskResult[],
  baseline: EvalTaskResult[]
): { id: string; from: number; to: number }[] {
  const baselineById = new Map(baseline.map((task) => [task.task.id, task]));
  return current.flatMap((task) => {
    const previous = baselineById.get(task.task.id);
    if (previous === undefined) {
      return [];
    }
    if (previous.successRate > 0 && task.successRate < previous.successRate) {
      return [{ from: previous.successRate, id: task.task.id, to: task.successRate }];
    }
    return [];
  });
}
