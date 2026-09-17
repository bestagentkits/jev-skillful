/**
 * Layer 1 metrics: did retrieval put the right capability in front of the model?
 *
 * Measured separately from the decision stage because the two fail for different reasons.
 * A low recall@K means BM25 or the quota composition is wrong and no amount of prompt
 * tuning will fix it; a low top-1 accuracy with a high recall@K means the model had the
 * right candidate and chose otherwise.
 *
 * Abstain fixtures are excluded from these metrics. There is no gold capability to
 * retrieve, and counting "no gold found" as a retrieval failure would conflate a correct
 * abstention with a miss.
 */

import type { RouteDecision } from "../../router/route.js";
import type { FixtureGroup } from "../fixtures.js";

/** One fixture's result from one routing run. */
export interface FixtureOutcome {
  fixtureId: string;
  group: FixtureGroup;
  expectAbstain: boolean;
  goldIds: string[];
  shortlist: string[];
  decision: RouteDecision;
  latencyMs: number;
  tokensIn?: number;
  tokensOut?: number;
}

export interface KindRetrieval {
  sampleSize: number;
  /** How often at least one gold capability was in the shortlist. */
  recall: number;
  /** Mean reciprocal rank of the first gold capability in the shortlist. */
  mrr: number;
}

export interface RetrievalMetrics {
  /** Non-abstain fixtures only. */
  sampleSize: number;
  /**
   * Fraction of fixtures where at least one gold capability reached the shortlist.
   *
   * This is the ceiling on everything downstream: a capability that never reaches the
   * shortlist cannot be chosen.
   */
  recallAtK: number;
  /** Mean reciprocal rank of the first gold capability, 0 when it never appeared. */
  mrr: number;
  /**
   * Fraction of gold capabilities that reached the shortlist, counted per item.
   *
   * For a fixture with three acceptable answers, `recallAtK` is satisfied by any one of
   * them, while this reports how many of the three were offered. The gap between the two
   * is the cost of a narrow shortlist.
   */
  goldInShortlistRate: number;
  /** Recall broken down by the kind of the gold capability. */
  byKind: Record<string, KindRetrieval>;
}

export function retrievalMetrics(outcomes: readonly FixtureOutcome[]): RetrievalMetrics {
  const scorable = outcomes.filter((outcome) => !outcome.expectAbstain);

  if (scorable.length === 0) {
    return { sampleSize: 0, recallAtK: 0, mrr: 0, goldInShortlistRate: 0, byKind: {} };
  }

  let hits = 0;
  let reciprocalRankSum = 0;
  let goldItems = 0;
  let goldItemsFound = 0;

  // Kind is derived from the gold id's position in the catalog, which is not available
  // here, so a fixture contributes to every kind its gold ids cover. `goldKinds` is
  // resolved separately in `retrievalMetricsByKind`.
  const byKind: Record<string, KindRetrieval> = {};

  for (const outcome of scorable) {
    const shortlist = new Set(outcome.shortlist);
    const ranks = outcome.goldIds
      .map((id, index) => ({ id, rank: outcome.shortlist.indexOf(id), index }))
      .filter((entry) => entry.rank >= 0);

    goldItems += outcome.goldIds.length;
    goldItemsFound += ranks.length;

    if (ranks.length > 0) {
      hits += 1;
      const bestRank = Math.min(...ranks.map((entry) => entry.rank));
      reciprocalRankSum += 1 / (bestRank + 1);
    }
  }

  return {
    sampleSize: scorable.length,
    recallAtK: hits / scorable.length,
    mrr: reciprocalRankSum / scorable.length,
    goldInShortlistRate: goldItems === 0 ? 0 : goldItemsFound / goldItems,
    byKind,
  };
}

/** Recall grouped by the kind of the gold capability. */
export function retrievalMetricsByKind(
  outcomes: readonly FixtureOutcome[],
  kindOf: (goldId: string) => string | undefined,
): Record<string, KindRetrieval> {
  const buckets = new Map<string, { total: number; hits: number; rrSum: number }>();

  for (const outcome of outcomes) {
    if (outcome.expectAbstain) continue;

    const seenKinds = new Set<string>();
    let hitThisFixture = false;
    let bestRank = Number.POSITIVE_INFINITY;

    for (const goldId of outcome.goldIds) {
      const kind = kindOf(goldId);
      if (kind === undefined) continue;
      seenKinds.add(kind);

      const rank = outcome.shortlist.indexOf(goldId);
      if (rank >= 0) {
        hitThisFixture = true;
        bestRank = Math.min(bestRank, rank);
      }
    }

    for (const kind of seenKinds) {
      const bucket = buckets.get(kind) ?? { total: 0, hits: 0, rrSum: 0 };
      bucket.total += 1;
      if (hitThisFixture) {
        bucket.hits += 1;
        bucket.rrSum += 1 / (bestRank + 1);
      }
      buckets.set(kind, bucket);
    }
  }

  const out: Record<string, KindRetrieval> = {};
  for (const [kind, bucket] of buckets) {
    out[kind] = {
      sampleSize: bucket.total,
      recall: bucket.total === 0 ? 0 : bucket.hits / bucket.total,
      mrr: bucket.total === 0 ? 0 : bucket.rrSum / bucket.total,
    };
  }
  return out;
}
