/**
 * Significance for paired binary outcomes.
 *
 * **McNemar, not a two-proportion test.** The two arms run the same tasks, so the observations are
 * paired and the informative quantity is the discordant pairs: tasks where exactly one arm passed.
 * Treating the arms as independent samples throws away the pairing, and with a handful of tasks the
 * resulting test is both underpowered and wrong in the direction it is wrong.
 *
 * **The bootstrap resamples tasks, not runs.** Each task contributes one paired observation. If the
 * resampling unit were the individual run, repeated runs of the same task would be treated as
 * independent evidence, and the interval would shrink as repeats increased even though no new task
 * was added. That is a way to manufacture significance by running the same task more times, so the
 * unit here is the task and it is asserted in the tests.
 *
 * The normal approximation to McNemar is used with a continuity correction when the discordant count
 * is small, because an exact test is the right answer and this is the standard honest approximation
 * to it.
 */

export interface TaskRuns {
  taskId: string;
  /** Whether the task passed with injection enabled, one entry per repeat. */
  treatmentSuccesses: readonly boolean[];
  /** Whether the task passed with injection disabled, one entry per repeat. */
  controlSuccesses: readonly boolean[];
  /** Whether injection actually occurred. */
  injected: boolean;
}

export interface TaskLevelOutcome {
  taskId: string;
  injected: boolean;
  treatmentSuccess: boolean;
  controlSuccess: boolean;
}

/**
 * Reduce repeated runs of each task to one binary outcome per arm.
 *
 * Majority wins, and a tie counts as failure. The tie rule is conservative on purpose: a task that
 * passes half the time is not a task the treatment reliably fixes, and counting it as a pass would
 * let nondeterminism look like an effect.
 *
 * This exists because the alternative — passing raw per-run outcomes downstream — silently inflates
 * the apparent sample size. Making the reduction explicit and named is cheaper than remembering not
 * to skip it.
 */
export function reduceRunsToBinary(runs: readonly TaskRuns[]): TaskLevelOutcome[] {
  return runs.map((task) => ({
    taskId: task.taskId,
    injected: task.injected,
    treatmentSuccess: majority(task.treatmentSuccesses),
    controlSuccess: majority(task.controlSuccesses),
  }));
}

/** True when strictly more than half the runs passed. A tie is false. */
function majority(outcomes: readonly boolean[]): boolean {
  if (outcomes.length === 0) return false;
  const passes = outcomes.filter(Boolean).length;
  return passes * 2 > outcomes.length;
}

/**
 * One difference per task, ready for `pairedBootstrapCi`.
 *
 * Returns `null` for tasks where injection did not happen, because those carry no evidence about the
 * treatment and including them would pull the interval toward zero.
 */
export function taskLevelDifferences(runs: readonly TaskRuns[]): number[] {
  return reduceRunsToBinary(runs)
    .filter((task) => task.injected)
    .map((task) => (task.treatmentSuccess ? 1 : 0) - (task.controlSuccess ? 1 : 0));
}

export interface BootstrapOptions {
  /** Number of resamples. 10,000 is the plan's figure. */
  iterations?: number;
  /** Confidence level. 0.95 by default. */
  level?: number;
  /** Injected so a test can produce a deterministic interval. */
  seed?: number;
}

export interface Interval {
  low: number;
  high: number;
  level: number;
  iterations: number;
}

/**
 * A small deterministic PRNG (mulberry32).
 *
 * Math.random would make a benchmark result unreproducible, and a confidence interval nobody can
 * recompute is not evidence. A seed in the report lets a reader regenerate the exact interval.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Paired bootstrap confidence interval for a mean difference.
 *
 * `paired` is one number per task: treatment outcome minus control outcome, so 0, +1 or -1. The
 * resampling unit is the array element, which is a task.
 */
/**
 * Paired bootstrap confidence interval for a mean difference.
 *
 * `paired` must hold **one value per task**, not one per run. The resampling unit is the array
 * element, so passing repeated runs of the same task narrows the interval without adding any new
 * evidence — a way to manufacture significance by running the same task more times. Callers with
 * repeated runs must reduce to one value per task first; `taskLevelDifferences` does that and is the
 * supported entry point for that case.
 */
export function pairedBootstrapCi(
  paired: readonly number[],
  options: BootstrapOptions = {},
): Interval {
  const iterations = options.iterations ?? 10_000;
  const level = options.level ?? 0.95;
  const random = mulberry32(options.seed ?? 20260917);

  if (paired.length === 0) return { low: 0, high: 0, level, iterations: 0 };

  const means = new Array<number>(iterations);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0;
    for (let draw = 0; draw < paired.length; draw += 1) {
      const index = Math.floor(random() * paired.length);
      total += paired[index] ?? 0;
    }
    means[iteration] = total / paired.length;
  }

  means.sort((a, b) => a - b);

  const alpha = (1 - level) / 2;
  const lowIndex = Math.max(0, Math.floor(alpha * iterations));
  const highIndex = Math.min(iterations - 1, Math.ceil((1 - alpha) * iterations) - 1);

  return {
    low: means[lowIndex] ?? 0,
    high: means[highIndex] ?? 0,
    level,
    iterations,
  };
}

export interface McnemarResult {
  /** Control passed, treatment failed. */
  b: number;
  /** Control failed, treatment passed. */
  c: number;
  /** Discordant pairs, `b + c`. */
  discordant: number;
  statistic: number;
  /** Degrees of freedom; 1 for McNemar. */
  df: number;
  pValue: number;
  /** True when the test cannot distinguish the arms at all. */
  degenerate: boolean;
  note: string;
}

/**
 * McNemar's test with a continuity correction.
 *
 * Exact McNemar (the binomial test on `b` of `b + c`) is the correct test when discordant counts are
 * small, which is the normal case here. The chi-square approximation below agrees closely above
 * roughly 25 discordant pairs and is reported with a note when it does not.
 */
export function mcnemar(b: number, c: number): McnemarResult {
  const discordant = b + c;

  if (discordant === 0) {
    return {
      b,
      c,
      discordant: 0,
      statistic: 0,
      df: 1,
      pValue: 1,
      degenerate: true,
      note: "The arms never disagreed, so there is nothing to test. Every task had the same outcome with and without injection.",
    };
  }

  // Continuity-corrected chi-square.
  const statistic = (Math.abs(b - c) - 1) ** 2 / discordant;
  const pValue = 1 - chiSquareCdf(statistic, 1);

  return {
    b,
    c,
    discordant,
    statistic,
    df: 1,
    pValue,
    degenerate: false,
    note:
      discordant < 25
        ? `Only ${discordant} discordant pair(s). The chi-square approximation is unreliable below about 25; an exact binomial test on ${b} of ${discordant} would be the stronger choice.`
        : "",
  };
}

/**
 * Chi-square CDF for 1 degree of freedom.
 *
 * Closed form rather than a table: for df=1 the survival function is `erfc(sqrt(x/2))`.
 */
export function chiSquareCdf(x: number, df: number): number {
  if (df !== 1) {
    throw new Error("chiSquareCdf is implemented only for 1 degree of freedom, which is all McNemar needs");
  }
  if (x <= 0) return 0;
  return erf(Math.sqrt(x / 2));
}

/** Error function, Abramowitz and Stegun 7.1.26. Absolute error below 1.5e-7. */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  return sign * y;
}

export interface ConclusionInput {
  rae: number;
  interval: Interval;
  /** Minimum detectable effect at the achieved sample size. */
  mde: number | null;
}

export type Conclusion = "proven" | "not-proven" | "harmful";

/**
 * Apply the pre-agreed evidence threshold.
 *
 * The threshold was fixed before any benchmark ran and is not adjusted afterwards: `proven` requires
 * RAE above zero **and** an interval excluding zero. Anything else is `not-proven`, and a negative RAE
 * with an interval excluding zero is `harmful`.
 *
 * Note the asymmetry, which is deliberate. A positive point estimate with an interval that includes
 * zero is not a small win, it is no demonstrated effect. A negative point estimate with an interval
 * including zero is also `not-proven` rather than `harmful`, because the same lack of evidence cuts
 * both ways.
 */
export function conclude(input: ConclusionInput): { conclusion: Conclusion; reason: string } {
  const { rae, interval } = input;

  if (interval.iterations === 0) {
    return { conclusion: "not-proven", reason: "No paired observations were available." };
  }

  const excludesZero = interval.low > 0 || interval.high < 0;

  if (rae > 0 && excludesZero) {
    return {
      conclusion: "proven",
      reason: `RAE is positive and the ${Math.round(interval.level * 100)}% interval [${interval.low.toFixed(3)}, ${interval.high.toFixed(3)}] excludes zero.`,
    };
  }

  if (rae < 0 && excludesZero) {
    return {
      conclusion: "harmful",
      reason: `RAE is negative and the ${Math.round(interval.level * 100)}% interval [${interval.low.toFixed(3)}, ${interval.high.toFixed(3)}] excludes zero: injection made outcomes worse on the tasks it reached.`,
    };
  }

  const power =
    input.mde === null
      ? ""
      : ` At this sample size only effects of ${input.mde.toFixed(3)} or larger would be detectable, so an effect smaller than that cannot be ruled out.`;

  return {
    conclusion: "not-proven",
    reason: `The ${Math.round(interval.level * 100)}% interval [${interval.low.toFixed(3)}, ${interval.high.toFixed(3)}] contains zero, so no effect is demonstrated.${power}`,
  };
}
