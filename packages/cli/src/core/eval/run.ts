/**
 * The eval runner: fixtures × repeats → one report.
 *
 * The `callRoute` injection point is what makes `--replay` possible. The runner never knows
 * whether a result came from the live API or from a recording, so the metrics and the report
 * are identical in both modes, and CI can run the whole gate without a key.
 */

import type { CatalogEntry, CatalogKind } from "../catalog/types.js";
import { route, type RouteResult } from "../router/route.js";
import type { RouteThresholds } from "../router/thresholds.js";
import type { QuotaGroup } from "../retrieval/shortlist.js";
import { decisionMetrics, decisionMetricsByGroup, decisionSignature, type DecisionMetrics } from "./metrics/decision.js";
import { latencyMetrics, type LatencyMetrics } from "./metrics/latency.js";
import type { FixtureOutcome } from "./metrics/retrieval.js";
import { retrievalMetrics, retrievalMetricsByKind, type RetrievalMetrics } from "./metrics/retrieval.js";
import { stabilityMetrics, type StabilityMetrics } from "./metrics/stability.js";
import type { FixtureGroup, ResolvedFixture } from "./fixtures.js";

/** A pluggable route implementation, so the runner works live or from a recording. */
export type RouteCaller = (
  prompt: string,
  options: {
    entries: readonly CatalogEntry[];
    thresholds: Partial<RouteThresholds>;
    quotaGroups: readonly QuotaGroup[];
    model: string;
    uploadPrompt: boolean;
  },
) => Promise<RouteResult>;

export interface EvalConfig {
  thresholds: Partial<RouteThresholds>;
  quotaGroups: readonly QuotaGroup[];
  model: string;
  uploadPrompt: boolean;
}

export interface EvalOptions {
  fixtures: readonly ResolvedFixture[];
  entries: readonly CatalogEntry[];
  repeat: number;
  config: EvalConfig;
  /** Defaults to the real router. */
  callRoute?: RouteCaller;
  onProgress?: (done: number, total: number) => void;
}

export interface EvalReport {
  aggregate: {
    retrieval: RetrievalMetrics;
    decision: DecisionMetrics;
    stability: StabilityMetrics;
    latency: LatencyMetrics;
  };
  /** Every metric that can be scoped, recomputed per fixture group. */
  byGroup: Record<
    string,
    { retrieval: RetrievalMetrics; decision: DecisionMetrics; latency: LatencyMetrics }
  >;
  byKind: Record<string, ReturnType<typeof retrievalMetricsByKind>[string]>;
  meta: {
    fixtureCount: number;
    repeat: number;
    totalRuns: number;
    config: EvalConfig;
    groupCounts: Record<string, number>;
  };
  outcomes: FixtureOutcome[];
}

/** The default caller: the real router against the real catalog. */
const liveRouteCaller: RouteCaller = (prompt, options) =>
  route(prompt, {
    entries: options.entries,
    thresholds: options.thresholds,
    quotaGroups: options.quotaGroups,
    model: options.model,
    uploadPrompt: options.uploadPrompt,
    // The api key comes from the environment inside the client; nothing extra is needed.
  });

function bucketBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [item]);
    } else {
      bucket.push(item);
    }
  }
  return buckets;
}

/**
 * Run every fixture `repeat` times and compute the report.
 *
 * Aggregates treat each *run* as a sample, so with `--repeat 5` and 67 fixtures the decision
 * and latency metrics have 335 samples. Stability is the exception: it is computed per
 * fixture across its repeats, because that is the only way it means anything.
 */
export async function runEval(options: EvalOptions): Promise<EvalReport> {
  const callRoute = options.callRoute ?? liveRouteCaller;
  const repeat = Math.max(1, Math.floor(options.repeat));
  const outcomes: FixtureOutcome[] = [];
  const signaturesByFixture = new Map<string, string[]>();

  const total = options.fixtures.length * repeat;
  let done = 0;

  for (const fixture of options.fixtures) {
    const signatures: string[] = [];

    for (let run = 0; run < repeat; run += 1) {
      const result = await callRoute(fixture.prompt, {
        entries: options.entries,
        thresholds: options.config.thresholds,
        quotaGroups: options.config.quotaGroups,
        model: options.config.model,
        uploadPrompt: options.config.uploadPrompt,
      });

      outcomes.push({
        fixtureId: fixture.id,
        group: fixture.group,
        expectAbstain: fixture.expectAbstain,
        goldIds: fixture.goldIds,
        shortlist: result.shortlist,
        decision: result.decision,
        latencyMs: result.latencyMs,
        ...(result.tokensIn === undefined ? {} : { tokensIn: result.tokensIn }),
        ...(result.tokensOut === undefined ? {} : { tokensOut: result.tokensOut }),
      });

      signatures.push(decisionSignature(result.decision));
      done += 1;
      options.onProgress?.(done, total);
    }

    signaturesByFixture.set(fixture.id, signatures);
  }

  const kindIndex = new Map<string, CatalogKind>();
  for (const fixture of options.fixtures) {
    fixture.goldIds.forEach((id, index) => {
      const kind = fixture.goldKinds[index];
      if (kind !== undefined) kindIndex.set(id, kind);
    });
  }

  const budgetMs = options.config.thresholds.budgetMs ?? 2000;
  const latencies = outcomes.map((outcome) => outcome.latencyMs);
  const tokensIn = outcomes.map((outcome) => outcome.tokensIn).filter((v): v is number => v !== undefined);
  const tokensOut = outcomes.map((outcome) => outcome.tokensOut).filter((v): v is number => v !== undefined);

  const byGroup: EvalReport["byGroup"] = {};
  for (const [group, bucket] of bucketBy(outcomes, (outcome) => outcome.group)) {
    byGroup[group] = {
      retrieval: retrievalMetrics(bucket),
      decision: decisionMetrics(bucket),
      latency: latencyMetrics(
        bucket.map((outcome) => outcome.latencyMs),
        { budgetMs },
      ),
    };
  }

  const groupCounts: Record<string, number> = {};
  for (const fixture of options.fixtures) {
    groupCounts[fixture.group] = (groupCounts[fixture.group] ?? 0) + 1;
  }

  return {
    aggregate: {
      retrieval: {
        ...retrievalMetrics(outcomes),
        byKind: retrievalMetricsByKind(outcomes, (id) => kindIndex.get(id)),
      },
      decision: decisionMetrics(outcomes),
      stability: stabilityMetrics(
        [...signaturesByFixture].map(([fixtureId, signatures]) => ({ fixtureId, signatures })),
        repeat,
      ),
      latency: latencyMetrics(latencies, { budgetMs, tokensIn, tokensOut }),
    },
    byGroup,
    byKind: retrievalMetricsByKind(outcomes, (id) => kindIndex.get(id)),
    meta: {
      fixtureCount: options.fixtures.length,
      repeat,
      totalRuns: outcomes.length,
      config: options.config,
      groupCounts,
    },
    outcomes,
  };
}

/** Decision groups present in a fixture set, for reporting. */
export function fixtureGroupsOf(fixtures: readonly ResolvedFixture[]): FixtureGroup[] {
  return [...new Set(fixtures.map((fixture) => fixture.group))];
}
