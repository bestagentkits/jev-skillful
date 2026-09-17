/**
 * Layer 2 metrics: did the router choose correctly, including choosing nothing?
 *
 * SRA-Bench observed that current agents load skills at a similar rate whether or not the
 * task needs one, which is why abstention is measured as its own axis rather than folded
 * into accuracy. A router that injects a plausible capability for every prompt can post a
 * respectable top-1 accuracy on a fixture set that is mostly positive examples, while being
 * actively harmful on the majority of real prompts, which need nothing.
 */

import type { RouteDecision } from "../../router/route.js";
import type { FixtureGroup } from "../fixtures.js";
import type { FixtureOutcome } from "./retrieval.js";

export interface DecisionMetrics {
  sampleSize: number;
  /**
   * Overall correctness, counting abstain fixtures.
   *
   * A fixture is correct when the router abstained and should have, or picked a gold
   * capability. A degraded result is never correct: it means the router did not decide.
   */
  top1Accuracy: number;
  /**
   * Fraction of fixtures where the option to inject or abstain was itself right.
   *
   * This differs from `top1Accuracy` in that it does not require the *right* capability,
   * only the right kind of decision. The gap between the two is the cost of retrieval
   * misses rather than of bad judgement.
   */
  abstentionCorrectness: number;
  /** Of the fixtures where the router abstained, how many should have. */
  nonePrecision: number;
  /** Of the fixtures where it should have abstained, how many it did. */
  noneRecall: number;
  noneF1: number;
  /** Fixtures where the router failed rather than deciding. Excluded from accuracy. */
  degradedCount: number;
  degradedRate: number;
  /** Counts behind the ratios, so a report can show its own sample sizes. */
  counts: {
    expectAbstain: number;
    actuallyAbstained: number;
    trueAbstain: number;
    correctPick: number;
    wrongPick: number;
    missedAbstain: number;
  };
}

/** True when the router declined to inject. A degraded result is a failure, not a decline. */
export function abstained(decision: RouteDecision): boolean {
  return decision.kind === "skipped";
}

/** The capability the router chose, or undefined when it chose nothing or failed. */
export function chosenId(decision: RouteDecision): string | undefined {
  return decision.kind === "injected" ? decision.primary.id : undefined;
}

/** A stable signature of what the router decided, used for agreement between repeats. */
export function decisionSignature(decision: RouteDecision): string {
  switch (decision.kind) {
    case "injected":
      return `injected:${decision.primary.id}`;
    case "skipped":
      return `skipped:${decision.reason}`;
    case "degraded":
      return `degraded:${decision.reason}`;
  }
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function decisionMetrics(outcomes: readonly FixtureOutcome[]): DecisionMetrics {
  const counts = {
    expectAbstain: 0,
    actuallyAbstained: 0,
    trueAbstain: 0,
    correctPick: 0,
    wrongPick: 0,
    missedAbstain: 0,
  };
  let degradedCount = 0;
  let correct = 0;

  for (const outcome of outcomes) {
    if (outcome.decision.kind === "degraded") {
      degradedCount += 1;
      continue;
    }

    const didAbstain = abstained(outcome.decision);
    if (outcome.expectAbstain) counts.expectAbstain += 1;
    if (didAbstain) counts.actuallyAbstained += 1;

    if (outcome.expectAbstain && didAbstain) {
      counts.trueAbstain += 1;
      correct += 1;
      continue;
    }
    if (!outcome.expectAbstain && didAbstain) {
      counts.missedAbstain += 1;
      continue;
    }

    const pick = chosenId(outcome.decision);
    if (pick !== undefined && outcome.goldIds.includes(pick)) {
      counts.correctPick += 1;
      correct += 1;
    } else {
      counts.wrongPick += 1;
    }
  }

  const precision = safeRatio(counts.trueAbstain, counts.actuallyAbstained);
  const recall = safeRatio(counts.trueAbstain, counts.expectAbstain);

  return {
    sampleSize: outcomes.length,
    top1Accuracy: safeRatio(correct, outcomes.length),
    abstentionCorrectness:
      safeRatio(counts.trueAbstain + counts.correctPick + counts.wrongPick, outcomes.length),
    nonePrecision: precision,
    noneRecall: recall,
    noneF1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    degradedCount,
    degradedRate: safeRatio(degradedCount, outcomes.length),
    counts,
  };
}

/** Decision metrics restricted to one fixture group. */
export function decisionMetricsByGroup(
  outcomes: readonly FixtureOutcome[],
): Record<string, DecisionMetrics> {
  const buckets = new Map<FixtureGroup, FixtureOutcome[]>();
  for (const outcome of outcomes) {
    const bucket = buckets.get(outcome.group);
    if (bucket === undefined) {
      buckets.set(outcome.group, [outcome]);
    } else {
      bucket.push(outcome);
    }
  }

  const out: Record<string, DecisionMetrics> = {};
  for (const [group, bucket] of buckets) {
    out[group] = decisionMetrics(bucket);
  }
  return out;
}
