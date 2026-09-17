/**
 * Known-answer tests for the benchmark analysis.
 *
 * Every dataset here is small enough to compute the expected value by hand, and the expected value
 * is written out in the test. That is the point: an analysis module whose arithmetic is only checked
 * against its own output verifies nothing, and a benchmark whose arithmetic is wrong produces a
 * confident wrong conclusion about whether the tool works.
 *
 * The central test is the one where the aggregate lift and RAE disagree. That disagreement is the
 * paper's finding, it is the reason both numbers are reported, and a suite that never produces it
 * would not prove the implementation handles it.
 */

import { describe, expect, it } from "vitest";
import { computeQuadrants, describeQuadrants } from "./quadrants.js";
import { assertReportable, computeRae, describeRae, type TaskOutcome } from "./rae.js";
import {
  chiSquareCdf,
  conclude,
  erf,
  mcnemar,
  mulberry32,
  pairedBootstrapCi,
  reduceRunsToBinary,
  taskLevelDifferences,
} from "./significance.js";
import { computeMde, interpretMde, normalQuantile, requiredSampleSize } from "./power.js";
import { isUnstable, summariseTaxonomy, type HarmCase } from "./taxonomy.js";

/**
 * Six tasks. Four were injected, two were not.
 *
 *   T1 injected  control pass  treatment pass   difference  0
 *   T2 injected  control fail  treatment pass   difference +1   rescued
 *   T3 injected  control pass  treatment fail   difference -1   harmed
 *   T4 injected  control fail  treatment fail   difference  0
 *   T5 abstained control pass  treatment pass   difference  0   (not attributed)
 *   T6 abstained control pass  treatment fail   difference -1   (not attributed)
 *
 * Hand-computed:
 *   RAE            = (0 + 1 - 1 + 0) / 4                 = 0
 *   aggregateLift  = (0 + 1 - 1 + 0 + 0 - 1) / 6         = -1/6
 *   b = 1, c = 1, n = 6, nInvoked = 4
 *
 * The aggregate is negative while RAE is exactly zero. That is not a contrived case: T6's failure
 * has nothing to do with injection, and counting it in the treatment effect is precisely the error
 * the protocol exists to prevent.
 */
const DISAGREEING: TaskOutcome[] = [
  { taskId: "T1", injected: true, controlSuccess: true, treatmentSuccess: true },
  { taskId: "T2", injected: true, controlSuccess: false, treatmentSuccess: true },
  { taskId: "T3", injected: true, controlSuccess: true, treatmentSuccess: false },
  { taskId: "T4", injected: true, controlSuccess: false, treatmentSuccess: false },
  { taskId: "T5", injected: false, controlSuccess: true, treatmentSuccess: true },
  { taskId: "T6", injected: false, controlSuccess: true, treatmentSuccess: false },
];

describe("rae", () => {
  it("computes RAE over the invoked subset and the aggregate over everything", () => {
    const result = computeRae(DISAGREEING);

    expect(result.n).toBe(6);
    expect(result.nInvoked).toBe(4);
    expect(result.rae).toBe(0);
    expect(result.aggregateLift).toBeCloseTo(-1 / 6, 10);
    expect(result.b).toBe(1);
    expect(result.c).toBe(1);
  });

  it("does not attribute an abstained task's disagreement to the treatment", () => {
    // T6 fails only on the treatment arm but was never injected, so it must not appear in b.
    const result = computeRae(DISAGREEING);
    expect(result.b).toBe(1);
    // If the implementation counted every disagreement, b would be 2.
    expect(result.b).not.toBe(2);
  });

  it("reports a clean rescue case", () => {
    const outcomes: TaskOutcome[] = [
      { taskId: "A", injected: true, controlSuccess: false, treatmentSuccess: true },
      { taskId: "B", injected: true, controlSuccess: false, treatmentSuccess: true },
      { taskId: "C", injected: true, controlSuccess: true, treatmentSuccess: true },
    ];

    const result = computeRae(outcomes);
    expect(result.rae).toBeCloseTo(2 / 3, 10);
    expect(result.b).toBe(0);
    expect(result.c).toBe(2);
  });

  it("reports a clean harm case, and the conclusion is harmful rather than merely unpromising", () => {
    const outcomes: TaskOutcome[] = [
      { taskId: "A", injected: true, controlSuccess: true, treatmentSuccess: false },
      { taskId: "B", injected: true, controlSuccess: true, treatmentSuccess: false },
      { taskId: "C", injected: true, controlSuccess: false, treatmentSuccess: false },
    ];

    const result = computeRae(outcomes);
    expect(result.rae).toBeCloseTo(-2 / 3, 10);
    expect(result.b).toBe(2);
    expect(result.c).toBe(0);
  });

  it("handles an all-abstained suite without dividing by zero", () => {
    const outcomes: TaskOutcome[] = [
      { taskId: "A", injected: false, controlSuccess: true, treatmentSuccess: false },
    ];

    const result = computeRae(outcomes);
    expect(result.nInvoked).toBe(0);
    expect(result.rae).toBe(0);
    expect(result.aggregateLift).toBeCloseTo(-1, 10);
    // The description must not read as "no effect" when nothing was tested.
    expect(describeRae(result)).toContain("No task received injection");
  });

  it("handles an empty suite", () => {
    const result = computeRae([]);
    expect(result).toEqual({ n: 0, nInvoked: 0, rae: 0, aggregateLift: 0, b: 0, c: 0 });
  });

  it("refuses an impossible result", () => {
    expect(() => assertReportable({ n: 3, nInvoked: 5, rae: 0, aggregateLift: 0, b: 0, c: 0 })).toThrow();
    expect(() =>
      assertReportable({ n: 2, nInvoked: 2, rae: 0, aggregateLift: 0, b: 2, c: 2 }),
    ).toThrow();
    expect(() => assertReportable(computeRae(DISAGREEING))).not.toThrow();
  });
});

describe("quadrants", () => {
  it("counts the four cells from the known dataset", () => {
    const quadrants = computeQuadrants(DISAGREEING);

    expect(quadrants.bothPassed).toBe(1); // T1
    expect(quadrants.rescued).toBe(1); // T2
    expect(quadrants.harmed).toBe(1); // T3
    expect(quadrants.bothFailed).toBe(1); // T4
    expect(quadrants.notInvoked).toBe(2); // T5, T6
  });

  it("makes the harmed cell impossible to miss in words", () => {
    // A summary that omits this is the failure mode the table exists to prevent.
    expect(describeQuadrants(computeQuadrants(DISAGREEING))).toContain("did worse with injection");
  });

  it("says so plainly when nothing was harmed", () => {
    const quadrants = computeQuadrants([
      { taskId: "A", injected: true, controlSuccess: true, treatmentSuccess: true },
    ]);
    expect(describeQuadrants(quadrants)).toContain("No task did worse");
  });

  it("handles an all-abstained suite", () => {
    const quadrants = computeQuadrants([
      { taskId: "A", injected: false, controlSuccess: true, treatmentSuccess: true },
    ]);
    expect(quadrants.notInvoked).toBe(1);
    expect(describeQuadrants(quadrants)).toContain("empty");
  });
});

describe("significance", () => {
  it("is deterministic given a seed, so an interval can be recomputed", () => {
    const paired = [0, 1, -1, 0, 1, 1, 0, 1, -1, 0];
    const first = pairedBootstrapCi(paired, { iterations: 2000, seed: 7 });
    const second = pairedBootstrapCi(paired, { iterations: 2000, seed: 7 });
    expect(first).toEqual(second);

    // The interval must be bounded by the data it came from. With ten observations in {-1, 0, 1} the
    // bootstrap mean is a multiple of 0.1 and cannot leave [-1, 1].
    //
    // An earlier version of this test asserted that different seeds produce different bounds. That is
    // not a property of the implementation: the bootstrap mean here takes only twenty-one distinct
    // values, so several seeds legitimately land on the same percentile. Asserting it would have
    // encoded a misunderstanding of the statistic as a requirement on the code.
    for (const seed of [1, 2, 3, 4, 5]) {
      const interval = pairedBootstrapCi(paired, { iterations: 2000, seed });
      expect(interval.low).toBeGreaterThanOrEqual(-1);
      expect(interval.high).toBeLessThanOrEqual(1);
      expect(interval.low).toBeLessThanOrEqual(interval.high);
      expect(interval.iterations).toBe(2000);
    }
  });

  it("brackets the observed mean", () => {
    // Mean is 2/4 = 0.5; the interval must contain it.
    const interval = pairedBootstrapCi([1, 1, 0, 0], { iterations: 4000, seed: 1 });
    expect(interval.low).toBeLessThanOrEqual(0.5);
    expect(interval.high).toBeGreaterThanOrEqual(0.5);
  });

  it("produces a degenerate interval when every task moves the same way", () => {
    const interval = pairedBootstrapCi([1, 1, 1, 1], { iterations: 2000, seed: 1 });
    expect(interval.low).toBe(1);
    expect(interval.high).toBe(1);
  });

  it("returns an empty interval for no observations rather than a false one", () => {
    const interval = pairedBootstrapCi([]);
    expect(interval.iterations).toBe(0);
    expect(interval.low).toBe(0);
    expect(interval.high).toBe(0);
  });

  it("reduces repeated runs to one outcome per task, so repeating a task cannot manufacture significance", () => {
    // Three tasks, each run ten times. The sample is three tasks, not thirty observations, so the
    // interval must be identical to the one computed from the three reduced outcomes.
    const runs = [
      { taskId: "A", injected: true, treatmentSuccesses: Array(10).fill(true), controlSuccesses: Array(10).fill(true) },
      { taskId: "B", injected: true, treatmentSuccesses: Array(10).fill(true), controlSuccesses: Array(10).fill(false) },
      { taskId: "C", injected: true, treatmentSuccesses: Array(10).fill(false), controlSuccesses: Array(10).fill(true) },
    ];

    const differences = taskLevelDifferences(runs);
    expect(differences).toEqual([0, 1, -1]);

    // The interval from the reduced differences is what gets reported.
    const fromReduced = pairedBootstrapCi(differences, { iterations: 4000, seed: 3 });
    expect(fromReduced.low).toBeLessThanOrEqual(0);
    expect(fromReduced.high).toBeGreaterThanOrEqual(0);

    // Passing raw per-run outcomes would have produced a much narrower interval, which is the bug
    // this API exists to prevent. The two are not equal, and the reduced one is the wider.
    const naive = pairedBootstrapCi(
      runs.flatMap((task) =>
        task.treatmentSuccesses.map(
          (t, index) => (t ? 1 : 0) - (task.controlSuccesses[index] ? 1 : 0),
        ),
      ),
      { iterations: 4000, seed: 3 },
    );
    expect(naive.high - naive.low).toBeLessThan(fromReduced.high - fromReduced.low);
  });

  it("excludes tasks that were not injected from the differences", () => {
    const differences = taskLevelDifferences([
      { taskId: "A", injected: true, treatmentSuccesses: [true], controlSuccesses: [false] },
      { taskId: "B", injected: false, treatmentSuccesses: [false], controlSuccesses: [true] },
    ]);
    // B's disagreement is not evidence about the treatment.
    expect(differences).toEqual([1]);
  });

  it("treats a tie across repeats as a failure rather than a pass", () => {
    const reduced = reduceRunsToBinary([
      { taskId: "A", injected: true, treatmentSuccesses: [true, false], controlSuccesses: [true, true] },
      { taskId: "B", injected: true, treatmentSuccesses: [true, true, true], controlSuccesses: [false] },
    ]);

    expect(reduced[0]?.treatmentSuccess).toBe(false);
    expect(reduced[1]?.treatmentSuccess).toBe(true);
    expect(reduceRunsToBinary([{ taskId: "C", injected: true, treatmentSuccesses: [], controlSuccesses: [] }])[0]?.treatmentSuccess).toBe(false);
  });

  it("computes McNemar on the discordant pairs only", () => {
    // b=10, c=2 with a continuity correction:
    //   statistic = (|10-2| - 1)^2 / 12 = 49/12 = 4.0833...
    const result = mcnemar(10, 2);
    expect(result.statistic).toBeCloseTo(49 / 12, 6);
    expect(result.discordant).toBe(12);
    // p = erf(sqrt(4.0833/2)) -> 1 - that. Roughly 0.043 for a one-sided-corrected 1-df test.
    expect(result.pValue).toBeGreaterThan(0.03);
    expect(result.pValue).toBeLessThan(0.06);
  });

  it("gives p=1 when the arms never disagreed, and says why", () => {
    const result = mcnemar(0, 0);
    expect(result.pValue).toBe(1);
    expect(result.degenerate).toBe(true);
    expect(result.note).toContain("never disagreed");
  });

  it("flags an unreliable approximation on a small discordant count", () => {
    expect(mcnemar(2, 1).note).toContain("unreliable");
    expect(mcnemar(30, 20).note).toBe("");
  });

  it("agrees with a known chi-square value", () => {
    // For df=1, the 95th percentile is 3.841; the CDF there must be about 0.95.
    expect(chiSquareCdf(3.841, 1)).toBeCloseTo(0.95, 2);
    expect(chiSquareCdf(0, 1)).toBe(0);
    // Only 1 degree of freedom is implemented. Throwing is deliberate: returning NaN or a wrong
    // number for a df the formula does not cover would be silently incorrect.
    expect(() => chiSquareCdf(1, 2)).toThrow();
  });

  it("computes erf to the documented accuracy", () => {
    expect(erf(0)).toBeCloseTo(0, 7);
    expect(erf(1)).toBeCloseTo(0.8427008, 6);
    expect(erf(-1)).toBeCloseTo(-0.8427008, 6);
  });

  it("only calls a result proven when the interval excludes zero on the right side", () => {
    expect(conclude({ rae: 0.2, interval: { low: 0.01, high: 0.4, level: 0.95, iterations: 100 }, mde: 0.1 }).conclusion).toBe("proven");
    // Positive point estimate, interval containing zero: not a small win, no demonstrated effect.
    expect(conclude({ rae: 0.2, interval: { low: -0.01, high: 0.4, level: 0.95, iterations: 100 }, mde: 0.3 }).conclusion).toBe("not-proven");
    // Negative and excluding zero: harmful.
    expect(conclude({ rae: -0.2, interval: { low: -0.4, high: -0.01, level: 0.95, iterations: 100 }, mde: 0.1 }).conclusion).toBe("harmful");
    // Negative but containing zero: the same lack of evidence cuts both ways.
    expect(conclude({ rae: -0.2, interval: { low: -0.4, high: 0.01, level: 0.95, iterations: 100 }, mde: 0.3 }).conclusion).toBe("not-proven");
    // No observations at all.
    expect(conclude({ rae: 0, interval: { low: 0, high: 0, level: 0.95, iterations: 0 }, mde: null }).conclusion).toBe("not-proven");
  });

  it("mentions the MDE when the result is not proven, so a null reads as underpowered rather than negative", () => {
    const result = conclude({
      rae: 0.05,
      interval: { low: -0.2, high: 0.3, level: 0.95, iterations: 1000 },
      mde: 0.25,
    });
    expect(result.conclusion).toBe("not-proven");
    expect(result.reason).toContain("0.250");
  });
});

describe("power", () => {
  it("computes normal quantiles against known values", () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 4);
    expect(normalQuantile(0.8)).toBeCloseTo(0.8416212, 4);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 6);
    expect(() => normalQuantile(0)).toThrow();
    expect(() => normalQuantile(1)).toThrow();
  });

  it("returns a larger MDE for a smaller sample", () => {
    const small = computeMde({ n: 20, discordant: 4 });
    const large = computeMde({ n: 200, discordant: 40 });

    expect(small.mde).not.toBeNull();
    expect(large.mde).not.toBeNull();
    expect(small.mde as number).toBeGreaterThan(large.mde as number);
  });

  it("refuses to report an MDE when nothing disagreed, because nothing could be detected", () => {
    const result = computeMde({ n: 40, discordant: 0 });
    expect(result.mde).toBeNull();
    expect(result.estimable).toBe(false);
    // The distinction matters: this is an uninformative result, not a null one.
    expect(result.note).toContain("uninformative");
  });

  it("handles an empty sample", () => {
    const result = computeMde({ n: 0, discordant: 0 });
    expect(result.mde).toBeNull();
    expect(result.estimable).toBe(false);
  });

  it("inverts the MDE formula for a required sample size", () => {
    const required = requiredSampleSize({ effect: 0.15, discordantRate: 0.3 });
    expect(required).not.toBeNull();

    // The inversion uses the continuous discordant rate, while `computeMde` is called with a whole
    // number of discordant pairs. Rounding `n * rate` up makes the realised rate slightly higher and
    // therefore the realised MDE slightly larger, so the check allows a one-task margin rather than
    // demanding an exact equality the arithmetic cannot deliver.
    const n = required as number;
    const check = computeMde({ n, discordant: Math.ceil(n * 0.3) });
    expect(check.mde as number).toBeLessThanOrEqual(0.15 * 1.02);

    // And one task fewer must be insufficient, or the formula is over-allocating.
    const smaller = computeMde({ n: n - 1, discordant: Math.ceil((n - 1) * 0.3) });
    expect((smaller.mde as number) > (check.mde as number)).toBe(true);

    expect(requiredSampleSize({ effect: 0, discordantRate: 0.3 })).toBeNull();
    expect(requiredSampleSize({ effect: 0.2, discordantRate: 0 })).toBeNull();
  });

  it("says the sample is inadequate rather than declaring no effect", () => {
    const mde = computeMde({ n: 12, discordant: 2 });
    expect(interpretMde(mde, 0.1)).toContain("too small");
    // And the opposite direction, so the function is not just always pessimistic.
    const big = computeMde({ n: 500, discordant: 150 });
    expect(interpretMde(big, 0.1)).toContain("adequate");
  });
});

describe("taxonomy", () => {
  const cases: HarmCase[] = [
    { taskId: "A", reason: "wrong-capability", evidence: "shortlist lacked the right skill", reruns: [false, false, false] },
    { taskId: "B", reason: "nondeterminism", evidence: "flips with identical input", reruns: [false, true, false] },
    { taskId: "C", reason: "wrong-capability", evidence: "picked the wrong one from a correct shortlist" },
  ];

  it("counts each reason, including the zeroes", () => {
    const summary = summariseTaxonomy(cases);
    expect(summary.total).toBe(3);
    expect(summary.byReason["wrong-capability"]).toBe(2);
    expect(summary.byReason["nondeterminism"]).toBe(1);
    // A missing category must be visible as zero rather than absent.
    expect(summary.byReason["context-bloat"]).toBe(0);
  });

  it("flags unstable cases rather than silently removing them", () => {
    const summary = summariseTaxonomy(cases);
    expect(summary.unstable).toBe(1);
    expect(isUnstable(cases[1] as HarmCase)).toBe(true);
    expect(isUnstable(cases[0] as HarmCase)).toBe(false);
    // One re-run cannot establish stability either way.
    expect(isUnstable({ taskId: "D", reason: "unknown", evidence: "", reruns: [false] })).toBe(false);
  });
});
