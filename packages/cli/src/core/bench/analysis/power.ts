/**
 * Statistical power, reported as the minimum detectable effect.
 *
 * A null result is only informative if the reader knows what size of effect the study could have
 * detected. "We found no effect with 20 tasks" and "we found no effect with 400 tasks" are different
 * statements, and without an MDE they look identical in a report.
 *
 * This matters more than usual here because the honest outcome of this phase may well be
 * `not-proven`. Reporting that alongside an MDE larger than any plausible effect is a statement
 * about the sample, and it tells the reader exactly what would change the answer. Reporting the same
 * result without an MDE reads as evidence that injection does not work, which the data would not
 * support.
 *
 * The approximation used is the standard one for a paired binary outcome: power depends on the
 * probability that the two arms disagree, not on the overall success rate. Two arms that both pass
 * 90% of the time while never disagreeing carry no information at all.
 */

export interface PowerInput {
  /** Tasks in the invoked subset, which is the sample the effect is estimated from. */
  n: number;
  /** Discordant pairs observed: tasks where exactly one arm passed. */
  discordant: number;
  /** Two-sided alpha. 0.05 by default. */
  alpha?: number;
  /** Target power. 0.8 by default. */
  power?: number;
}

export interface PowerResult {
  /** Smallest effect detectable at the achieved sample size and discordance. */
  mde: number | null;
  /** Proportion of pairs that disagreed. Drives everything else. */
  discordantRate: number | null;
  /** False when the sample carries no information at all. */
  estimable: boolean;
  note: string;
}

/** Standard normal quantile, Acklam's rational approximation. */
export function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) throw new Error("normalQuantile expects p strictly between 0 and 1");

  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

  const lower = 0.02425;
  const upper = 1 - lower;

  if (p < lower) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] as number) * q + (c[1] as number)) * q + (c[2] as number)) * q + (c[3] as number)) * q + (c[4] as number)) * q +
      (c[5] as number)
    ) / (((((d[0] as number) * q + (d[1] as number)) * q + (d[2] as number)) * q + (d[3] as number)) * q + 1);
  }

  if (p > upper) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(
      (((((c[0] as number) * q + (c[1] as number)) * q + (c[2] as number)) * q + (c[3] as number)) * q + (c[4] as number)) * q +
      (c[5] as number)
    ) / (((((d[0] as number) * q + (d[1] as number)) * q + (d[2] as number)) * q + (d[3] as number)) * q + 1);
  }

  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] as number) * r + (a[1] as number)) * r + (a[2] as number)) * r + (a[3] as number)) * r + (a[4] as number)) * r + (a[5] as number)) * q
  ) / ((((((b[0] as number) * r + (b[1] as number)) * r + (b[2] as number)) * r + (b[3] as number)) * r + (b[4] as number)) * r + 1);
}

/**
 * Minimum detectable effect for a paired binary outcome.
 *
 * Uses the standard formula for a paired proportion, where the variance of the difference is driven
 * by the discordant rate. When nothing disagreed, the study cannot detect any effect and the result
 * says so rather than returning zero, because an MDE of zero would read as perfect sensitivity.
 */
export function computeMde(input: PowerInput): PowerResult {
  const alpha = input.alpha ?? 0.05;
  const power = input.power ?? 0.8;

  if (input.n <= 0) {
    return { mde: null, discordantRate: null, estimable: false, note: "No tasks in the invoked subset." };
  }

  const discordantRate = input.discordant / input.n;

  if (input.discordant === 0) {
    return {
      mde: null,
      discordantRate: 0,
      estimable: false,
      note:
        "The arms never disagreed, so the difference has zero observed variance and no effect of any size could be detected. This is not a null result, it is an uninformative one.",
    };
  }

  const zAlpha = normalQuantile(1 - alpha / 2);
  const zBeta = normalQuantile(power);

  // Paired binary outcome: Var(difference) = P(discordant) / n.
  const standardError = Math.sqrt(discordantRate / input.n);
  const mde = (zAlpha + zBeta) * standardError;

  return {
    mde,
    discordantRate,
    estimable: true,
    note: `At ${input.n} tasks with ${input.discordant} discordant pair(s) (${(discordantRate * 100).toFixed(1)}%), an effect of ${mde.toFixed(3)} or larger would be detected ${(power * 100).toFixed(0)}% of the time.`,
  };
}

/** How many tasks would be needed to detect an effect of a given size. */
export function requiredSampleSize(input: { effect: number; discordantRate: number; power?: number; alpha?: number }): number | null {
  if (input.effect <= 0 || input.discordantRate <= 0) return null;

  const power = input.power ?? 0.8;
  const alpha = input.alpha ?? 0.05;
  const zAlpha = normalQuantile(1 - alpha / 2);
  const zBeta = normalQuantile(power);

  // Invert the MDE formula: n = ((zA + zB)^2 * discordanceRate) / effect^2.
  return Math.ceil(((zAlpha + zBeta) ** 2 * input.discordantRate) / input.effect ** 2);
}

/** Interpret the MDE against the effect that would matter. */
export function interpretMde(result: PowerResult, expectedEffect: number): string {
  if (result.mde === null) return result.note;
  if (result.mde <= expectedEffect) {
    return `The sample is adequate: it can detect an effect of ${expectedEffect.toFixed(3)} or larger.`;
  }
  return `The sample is too small to answer the question. This study can only detect effects of ${result.mde.toFixed(3)} or larger, while the effect worth detecting is around ${expectedEffect.toFixed(3)}. The correct conclusion is "not enough data", not "no effect".`;
}
