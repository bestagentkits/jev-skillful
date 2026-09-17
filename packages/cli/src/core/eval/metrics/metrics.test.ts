import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "../../catalog/types.js";
import type { RouteDecision } from "../../router/route.js";
import { ABSTAIN, FixtureError, parseFixtures, resolveFixtures } from "../fixtures.js";
import { decisionMetrics, decisionSignature } from "./decision.js";
import { latencyMetrics, percentile } from "./latency.js";
import type { FixtureOutcome } from "./retrieval.js";
import { retrievalMetrics, retrievalMetricsByKind } from "./retrieval.js";
import { stabilityMetrics } from "./stability.js";

/** Build an outcome with the fields a metric actually reads. */
function outcome(
  input: Partial<FixtureOutcome> & { decision: RouteDecision },
): FixtureOutcome {
  return {
    fixtureId: "f",
    group: "coding",
    expectAbstain: false,
    goldIds: [],
    shortlist: [],
    latencyMs: 0,
    ...input,
  };
}

const skipped: RouteDecision = { kind: "skipped", reason: "none-won" };

function injected(id: string): RouteDecision {
  return {
    kind: "injected",
    primary: { id, kind: "skill", name: id, description: "", sourcePath: "/tmp", alternates: [] },
    runnersUp: [],
    confidence: 1,
    noneP: 0,
  };
}

describe("retrievalMetrics", () => {
  const outcomes = [
    outcome({ goldIds: ["a"], shortlist: ["a", "b"], decision: injected("a") }),
    outcome({ goldIds: ["c"], shortlist: ["b", "c"], decision: injected("c") }),
    outcome({ goldIds: ["d"], shortlist: ["b"], decision: skipped }),
    // Abstain fixtures carry no gold and must not count as retrieval failures.
    outcome({ expectAbstain: true, shortlist: [], decision: skipped }),
  ];

  it("computes recall over non-abstain fixtures only", () => {
    const metrics = retrievalMetrics(outcomes);
    expect(metrics.sampleSize).toBe(3);
    expect(metrics.recallAtK).toBeCloseTo(2 / 3, 10);
  });

  it("computes MRR from the rank of the first gold hit", () => {
    // 1/1 for rank 0, 1/2 for rank 1, 0 for the miss.
    const metrics = retrievalMetrics(outcomes);
    expect(metrics.mrr).toBeCloseTo((1 + 0.5 + 0) / 3, 10);
  });

  it("reports gold-in-shortlist per item, which differs from per fixture", () => {
    const metrics = retrievalMetrics(outcomes);
    expect(metrics.goldInShortlistRate).toBeCloseTo(2 / 3, 10);
  });

  it("rates recall per fixture above per item when a fixture has several golds", () => {
    const multi = [
      outcome({ goldIds: ["a", "b", "c"], shortlist: ["a"], decision: injected("a") }),
    ];
    const metrics = retrievalMetrics(multi);
    // One of three answers was offered: the fixture is satisfied, the item coverage is not.
    expect(metrics.recallAtK).toBe(1);
    expect(metrics.goldInShortlistRate).toBeCloseTo(1 / 3, 10);
  });

  it("returns zeroed metrics rather than NaN when everything abstains", () => {
    const metrics = retrievalMetrics([outcome({ expectAbstain: true, decision: skipped })]);
    expect(metrics.sampleSize).toBe(0);
    expect(metrics.recallAtK).toBe(0);
    expect(Number.isNaN(metrics.mrr)).toBe(false);
  });

  it("breaks recall down by gold kind", () => {
    const kindOf = (id: string): string => (id === "a" ? "skill" : "mcp");
    const byKind = retrievalMetricsByKind(outcomes, kindOf);

    expect(byKind["skill"]?.sampleSize).toBe(1);
    expect(byKind["skill"]?.recall).toBe(1);
    expect(byKind["mcp"]?.sampleSize).toBe(2);
    expect(byKind["mcp"]?.recall).toBeCloseTo(1 / 2, 10);
  });
});

describe("decisionMetrics", () => {
  const outcomes = [
    outcome({ expectAbstain: true, shortlist: [], decision: skipped }),
    outcome({ expectAbstain: true, shortlist: [], decision: injected("x") }),
    outcome({ goldIds: ["y"], shortlist: ["y"], decision: injected("y") }),
    outcome({ goldIds: ["z"], shortlist: ["z"], decision: skipped }),
    outcome({ goldIds: ["w"], shortlist: ["w"], decision: { kind: "degraded", reason: "timeout" } }),
  ];

  it("counts a correct abstention as correct and a wrong pick as incorrect", () => {
    const metrics = decisionMetrics(outcomes);
    expect(metrics.sampleSize).toBe(5);
    expect(metrics.top1Accuracy).toBeCloseTo(2 / 5, 10);
  });

  it("computes none precision, recall and F1 from the confusion counts", () => {
    const metrics = decisionMetrics(outcomes);
    expect(metrics.counts.expectAbstain).toBe(2);
    expect(metrics.counts.actuallyAbstained).toBe(2);
    expect(metrics.counts.trueAbstain).toBe(1);
    expect(metrics.nonePrecision).toBeCloseTo(1 / 2, 10);
    expect(metrics.noneRecall).toBeCloseTo(1 / 2, 10);
    expect(metrics.noneF1).toBeCloseTo(0.5, 10);
  });

  it("separates the right decision from the right capability", () => {
    const metrics = decisionMetrics(outcomes);
    // Abstaining correctly, picking correctly, and picking wrongly are all "the right kind
    // of decision"; missing an abstention is not.
    expect(metrics.abstentionCorrectness).toBeCloseTo(3 / 5, 10);
  });

  it("excludes a degraded result from accuracy rather than counting it as abstention", () => {
    const metrics = decisionMetrics(outcomes);
    expect(metrics.degradedCount).toBe(1);
    expect(metrics.degradedRate).toBeCloseTo(1 / 5, 10);
  });

  it("returns zeroes rather than NaN on an empty sample", () => {
    const metrics = decisionMetrics([]);
    expect(metrics.top1Accuracy).toBe(0);
    expect(metrics.noneF1).toBe(0);
    expect(Number.isNaN(metrics.noneF1)).toBe(false);
  });

  it("gives an injected and a skipped decision different signatures", () => {
    expect(decisionSignature(injected("a"))).toBe("injected:a");
    expect(decisionSignature(skipped)).toBe("skipped:none-won");
    expect(decisionSignature(injected("a"))).not.toBe(decisionSignature(skipped));
  });
});

describe("stabilityMetrics", () => {
  it("counts a fixture as agreed only when every repeat matched", () => {
    const metrics = stabilityMetrics(
      [
        { fixtureId: "a", signatures: ["s1", "s1", "s1"] },
        { fixtureId: "b", signatures: ["s1", "s2", "s1"] },
        { fixtureId: "c", signatures: ["x", "x", "y"] },
      ],
      3,
    );

    expect(metrics.fixtureCount).toBe(3);
    expect(metrics.unanimous).toBe(1);
    expect(metrics.agreementRate).toBeCloseTo(1 / 3, 10);
    expect(metrics.unstable).toHaveLength(2);
  });

  it("lists the unstable fixtures so they can be inspected", () => {
    const metrics = stabilityMetrics(
      [{ fixtureId: "flappy", signatures: ["a", "b", "c"] }],
      3,
    );
    expect(metrics.unstable[0]?.fixtureId).toBe("flappy");
    expect(metrics.unstable[0]?.signatures).toEqual(["a", "b", "c"]);
  });

  it("reports a rate of zero for an empty set rather than NaN", () => {
    const metrics = stabilityMetrics([], 5);
    expect(metrics.agreementRate).toBe(0);
    expect(metrics.repeat).toBe(5);
  });
});

describe("latencyMetrics", () => {
  it("uses nearest-rank so a reported percentile is a time that happened", () => {
    const values = [100, 200, 300, 400, 500];
    expect(percentile(values, 0.5)).toBe(300);
    expect(percentile(values, 0.95)).toBe(500);
    expect(percentile(values, 0.99)).toBe(500);
    expect(percentile(values, 0)).toBe(100);
  });

  it("computes mean, max and the over-budget count", () => {
    const metrics = latencyMetrics([100, 200, 300, 400, 500], { budgetMs: 250 });
    expect(metrics.p50).toBe(300);
    expect(metrics.p95).toBe(500);
    expect(metrics.mean).toBe(300);
    expect(metrics.max).toBe(500);
    expect(metrics.overBudget).toBe(3);
    expect(metrics.budgetMs).toBe(250);
  });

  it("averages token counts when provided", () => {
    const metrics = latencyMetrics([10, 20], {
      budgetMs: 2000,
      tokensIn: [100, 300],
      tokensOut: [10, 30],
    });
    expect(metrics.meanTokensIn).toBe(200);
    expect(metrics.meanTokensOut).toBe(20);
  });

  it("returns zeroes for an empty sample", () => {
    const metrics = latencyMetrics([], { budgetMs: 2000 });
    expect(metrics.samples).toBe(0);
    expect(metrics.p95).toBe(0);
    expect(metrics.meanTokensIn).toBe(0);
  });
});

describe("parseFixtures", () => {
  it("parses a valid line and ignores comments and blanks", () => {
    const fixtures = parseFixtures(`
# a comment

{"id":"a","group":"coding","prompt":"do something real","gold":["x"]}
`);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]?.id).toBe("a");
  });

  it("reports the line number for invalid JSON", () => {
    expect(() => parseFixtures(`\n\n{not json}`)).toThrow(/3: not valid JSON/);
  });

  it("rejects an unknown group and names the allowed ones", () => {
    expect(() =>
      parseFixtures(`{"id":"a","group":"nonsense","prompt":"hello there","gold":["x"]}`),
    ).toThrow(/group must be one of/);
  });

  it("rejects a duplicate id and points at the first occurrence", () => {
    expect(() =>
      parseFixtures(
        `{"id":"dup","group":"coding","prompt":"first one here","gold":["x"]}\n` +
          `{"id":"dup","group":"coding","prompt":"second one here","gold":["x"]}`,
      ),
    ).toThrow(/duplicate id "dup"/);
  });

  it("rejects an empty gold array", () => {
    expect(() =>
      parseFixtures(`{"id":"a","group":"coding","prompt":"hello there","gold":[]}`),
    ).toThrow(/non-empty array/);
  });

  it("rejects none combined with a real capability", () => {
    expect(() =>
      parseFixtures(`{"id":"a","group":"coding","prompt":"hello there","gold":["none","x"]}`),
    ).toThrow(/cannot be combined/);
  });
});

describe("resolveFixtures", () => {
  const entry = (id: string, name: string): CatalogEntry => ({
    id,
    kind: "skill",
    name,
    description: "d",
    runtime: "pi",
    scope: "global",
    sourcePath: "/tmp",
  });

  const entries = [
    entry("claude-code:skill:global:ak-debug", "ak:debug"),
    entry("pi:skill:global:ak-debug", "ak-debug"),
    entry("pi:skill:global:ak-test", "ak-test"),
  ];

  it("resolves a name to every runtime copy of it", () => {
    const resolved = resolveFixtures(
      [{ id: "f", group: "coding", prompt: "debug this failure please", gold: ["ak-debug"] }],
      entries,
    );
    // Both installed copies are acceptable answers; which one runs is the hook's problem.
    // Compared as a set: `goldIds` is a set of acceptable ids, and the order in which the
    // two name lookups happen to contribute them carries no meaning.
    expect(new Set(resolved[0]?.goldIds)).toEqual(
      new Set(["claude-code:skill:global:ak-debug", "pi:skill:global:ak-debug"]),
    );
  });

  it("accepts an exact id as gold", () => {
    const resolved = resolveFixtures(
      [{ id: "f", group: "coding", prompt: "debug this failure please", gold: ["pi:skill:global:ak-test"] }],
      entries,
    );
    expect(resolved[0]?.goldIds).toEqual(["pi:skill:global:ak-test"]);
  });

  it("marks an abstain fixture and gives it no gold ids", () => {
    const resolved = resolveFixtures(
      [{ id: "f", group: "trivial", prompt: "thanks!", gold: [ABSTAIN] }],
      entries,
    );
    expect(resolved[0]?.expectAbstain).toBe(true);
    expect(resolved[0]?.goldIds).toEqual([]);
  });

  it("fails loudly when a gold capability is missing from the corpus", () => {
    expect(() =>
      resolveFixtures(
        [{ id: "f", group: "coding", prompt: "use a capability that is gone", gold: ["ak-vanished"] }],
        entries,
      ),
    ).toThrow(FixtureError);
  });
});
