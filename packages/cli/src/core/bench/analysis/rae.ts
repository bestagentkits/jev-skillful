/**
 * RAE and aggregate lift.
 *
 * These two numbers are computed over different task sets and they routinely disagree, which is the
 * entire reason both are reported together.
 *
 * **Aggregate lift** is the mean outcome difference over every task in the suite. It answers "did
 * the average task get better", and it is dominated by tasks the treatment never touched. A suite
 * where the router abstains on most tasks will show a lift near zero even if injection helps
 * enormously on the tasks it reaches.
 *
 * **RAE** — Relative Agentic Efficiency — is the mean outcome difference over only the tasks where
 * injection actually happened. It answers "when we did the thing, did it help".
 *
 * The paper this protocol follows demonstrates that the aggregate can be positive while the
 * conditioned effect is negative: the two can point in opposite directions. Reporting the aggregate
 * alone is therefore not a weaker version of the result, it is a different and misleading claim. The
 * guard in this module refuses to produce an aggregate without an RAE beside it.
 */

export interface TaskOutcome {
  taskId: string;
  /** Whether the task passed with injection enabled. */
  treatmentSuccess: boolean;
  /** Whether the task passed with injection disabled. */
  controlSuccess: boolean;
  /** Whether injection actually occurred on the treatment arm. */
  injected: boolean;
}

export interface RaeResult {
  /** Total tasks in the suite, after exclusions. */
  n: number;
  /** Tasks where injection happened. RAE is computed over these. */
  nInvoked: number;
  /** Mean outcome difference over the invoked subset. */
  rae: number;
  /**
   * Mean outcome difference over every task.
   *
   * Never returned without `rae` beside it; see `assertReportable`.
   */
  aggregateLift: number;
  /** Control passed and treatment failed. Injection hurt. */
  b: number;
  /** Control failed and treatment passed. Injection helped. */
  c: number;
}

/**
 * Compute RAE, aggregate lift and the discordant pair counts.
 *
 * Tasks where the router abstained are included in the aggregate and excluded from RAE. That
 * distinction is the whole point, so it is computed from `injected` rather than inferred from
 * whether the two arms disagree: a task can be injected and still pass in both arms, and it belongs
 * in the RAE denominator.
 */
export function computeRae(outcomes: readonly TaskOutcome[]): RaeResult {
  const n = outcomes.length;
  const invoked = outcomes.filter((outcome) => outcome.injected);
  const nInvoked = invoked.length;

  const difference = (outcome: TaskOutcome): number =>
    (outcome.treatmentSuccess ? 1 : 0) - (outcome.controlSuccess ? 1 : 0);

  const rae =
    nInvoked === 0 ? 0 : invoked.reduce((total, outcome) => total + difference(outcome), 0) / nInvoked;

  const aggregateLift =
    n === 0 ? 0 : outcomes.reduce((total, outcome) => total + difference(outcome), 0) / n;

  // Counted over the invoked subset only. A task the router never touched cannot have been harmed
  // by injection, and counting its disagreements would attribute them to the treatment.
  let b = 0;
  let c = 0;
  for (const outcome of invoked) {
    if (outcome.controlSuccess && !outcome.treatmentSuccess) b += 1;
    if (!outcome.controlSuccess && outcome.treatmentSuccess) c += 1;
  }

  return { n, nInvoked, rae, aggregateLift, b, c };
}

/**
 * Guard against reporting a lift without its conditions.
 *
 * This exists because the failure it prevents is silent. A number like "aggregate lift +0.04" reads
 * as a positive result on its own, and nothing about it reveals that the conditioned effect was
 * negative. Making the two inseparable in the type system is cheaper than remembering.
 */
export function assertReportable(result: RaeResult): void {
  if (!Number.isFinite(result.rae) || !Number.isFinite(result.aggregateLift)) {
    throw new Error("RAE and aggregate lift must both be finite");
  }
  if (result.nInvoked > result.n) {
    throw new Error(`nInvoked (${result.nInvoked}) cannot exceed n (${result.n})`);
  }
  if (result.nInvoked === 0) {
    // Not an error, but a caller that prints an RAE of 0 here is reporting "no effect" when the
    // truth is "nothing was tested".
    return;
  }
  if (result.b + result.c > result.nInvoked) {
    throw new Error("Discordant pairs cannot exceed the invoked subset");
  }
}

/** One line that states the result with everything needed to read it. */
export function describeRae(result: RaeResult): string {
  if (result.nInvoked === 0) {
    return `No task received injection, so no conditional effect can be computed (${result.n} tasks, aggregate ${formatSigned(result.aggregateLift)}).`;
  }
  return [
    `RAE ${formatSigned(result.rae)} over ${result.nInvoked} of ${result.n} tasks`,
    `aggregate ${formatSigned(result.aggregateLift)}`,
    `b=${result.b} c=${result.c}`,
  ].join(", ");
}

function formatSigned(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}
