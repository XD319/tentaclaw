export interface ConfidenceInterval {
  high: number;
  low: number;
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function percentile(values: number[], quantile: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function standardError(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const average = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance / values.length);
}

export function wilsonInterval(successes: number, trials: number, z = 1.96): ConfidenceInterval {
  if (trials === 0) {
    return { high: 0, low: 0 };
  }
  const proportion = successes / trials;
  const denominator = 1 + (z ** 2) / trials;
  const center = (proportion + (z ** 2) / (2 * trials)) / denominator;
  const margin = (z / denominator) * Math.sqrt((proportion * (1 - proportion)) / trials + (z ** 2) / (4 * trials ** 2));
  return {
    high: Math.min(1, center + margin),
    low: Math.max(0, center - margin)
  };
}

export function wilsonIntervalsOverlap(left: ConfidenceInterval, right: ConfidenceInterval): boolean {
  return left.low <= right.high && right.low <= left.high;
}

export function passAtK(successes: number, trials: number, k: number): number {
  if (trials === 0 || k <= 0) {
    return 0;
  }
  if (trials - successes < k) {
    return 1;
  }
  let failureProbability = 1;
  for (let index = 0; index < k; index += 1) {
    failureProbability *= (trials - successes - index) / (trials - index);
  }
  return 1 - failureProbability;
}

export function passPowerK(successes: number, trials: number, k: number): number {
  if (trials === 0 || k <= 0) {
    return 0;
  }
  return (successes / trials) ** k;
}

export function bootstrapMeanInterval(values: number[], iterations = 1_000, quantile = 0.025): ConfidenceInterval & { mean: number } {
  if (values.length === 0) {
    return { high: 0, low: 0, mean: 0 };
  }
  const observed = mean(values);
  if (values.length === 1) {
    return { high: observed, low: observed, mean: observed };
  }
  const samples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) {
      total += values[Math.floor(Math.random() * values.length)] ?? 0;
    }
    samples.push(total / values.length);
  }
  samples.sort((left, right) => left - right);
  const lowIndex = Math.min(samples.length - 1, Math.max(0, Math.floor(quantile * samples.length)));
  const highIndex = Math.min(samples.length - 1, Math.max(0, Math.ceil((1 - quantile) * samples.length) - 1));
  return {
    high: samples[highIndex] ?? observed,
    low: samples[lowIndex] ?? observed,
    mean: observed
  };
}
