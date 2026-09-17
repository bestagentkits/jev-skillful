/**
 * Latency metrics.
 *
 * Reported as percentiles rather than a mean because the routing budget is a hard ceiling:
 * what matters is how often the tail crosses `budgetMs`, not what the average looks like.
 * A mean hides the p95 that actually blows the budget.
 */

export interface LatencyMetrics {
  samples: number;
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  max: number;
  meanTokensIn: number;
  meanTokensOut: number;
  /** Samples that exceeded the routing budget they ran under. */
  overBudget: number;
  budgetMs: number;
}

/**
 * Nearest-rank percentile.
 *
 * Chosen over linear interpolation because these are wall-clock measurements of individual
 * requests, not an estimated distribution. "95% of requests finished within this many
 * milliseconds" is a statement about a request that actually happened, and interpolation
 * would report a time no request achieved.
 */
export function percentile(sortedAscending: readonly number[], fraction: number): number {
  if (sortedAscending.length === 0) return 0;
  const rank = Math.ceil(fraction * sortedAscending.length);
  const index = Math.min(Math.max(rank - 1, 0), sortedAscending.length - 1);
  return sortedAscending[index] ?? 0;
}

export function latencyMetrics(
  latencies: readonly number[],
  options: { budgetMs: number; tokensIn?: readonly number[]; tokensOut?: readonly number[] },
): LatencyMetrics {
  if (latencies.length === 0) {
    return {
      samples: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      mean: 0,
      max: 0,
      meanTokensIn: 0,
      meanTokensOut: 0,
      overBudget: 0,
      budgetMs: options.budgetMs,
    };
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const total = latencies.reduce((sum, value) => sum + value, 0);

  const meanOf = (values: readonly number[] | undefined): number => {
    if (values === undefined || values.length === 0) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  };

  return {
    samples: latencies.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    mean: total / latencies.length,
    max: sorted[sorted.length - 1] ?? 0,
    meanTokensIn: meanOf(options.tokensIn),
    meanTokensOut: meanOf(options.tokensOut),
    overBudget: latencies.filter((value) => value > options.budgetMs).length,
    budgetMs: options.budgetMs,
  };
}
