/**
 * Turning raw events into the numbers the dashboard shows.
 *
 * Everything here is a plain function over an array of events, so the whole report can be computed
 * from a fixture in a test without a filesystem or a clock.
 *
 * The adoption calculation is the part worth explaining. Correlating "a capability was suggested"
 * with "a capability was used" happens at read time, by session and a time window, rather than at
 * write time. The hook therefore stays stateless: it never has to remember what it suggested, so a
 * crash between routing and recording cannot corrupt a correlation. The cost is that the join can
 * be wrong — a session that used a capability for an unrelated reason looks like an acceptance —
 * which is why the result is reported as an observation and the doc says so plainly.
 */

import type { CapabilityUsedEvent, RouteEvent, TelemetryEvent } from "./events.js";
import { percentile } from "../eval/metrics/latency.js";

/** How long after a suggestion a use still counts as an acceptance of it. */
export const ACCEPTANCE_WINDOW_MS = 10 * 60 * 1000;

export interface OverviewStats {
  totalPrompts: number;
  injected: number;
  skipped: number;
  degraded: number;
  injectionRate: number;
  abstentionRate: number;
  degradeRate: number;
  cacheHitRate: number;
  /** Distinct sessions, as a rough measure of how many agents are being used. */
  sessions: number;
}

export interface OperationalStats {
  p50: number;
  p95: number;
  p99: number;
  meanLatencyMs: number;
  meanTokensIn: number | null;
  meanTokensOut: number | null;
  /** Degraded counts by cause, so a recurring cause is visible rather than averaged away. */
  degradeCauses: { reason: string; count: number }[];
  /** Skip counts by reason, which is where "this prompt needed nothing" shows up. */
  skipReasons: { reason: string; count: number }[];
}

export interface AdoptionStats {
  suggestions: number;
  observedUses: number;
  unmatchedUses: number;
  /** Accepted suggestions divided by suggestions. Null when there were none. */
  acceptanceRate: number | null;
  /** Uses whose source could not be observed, kept separate so they never inflate acceptance. */
  unobserved: number;
}

export interface CandidateStat {
  id: string;
  suggested: number;
  accepted: number;
}

export interface TelemetrySummary {
  overview: OverviewStats;
  operational: OperationalStats;
  adoption: AdoptionStats;
  /** Most frequently suggested capabilities, with their acceptance counts. */
  candidates: CandidateStat[];
  /** How many lines were unreadable. Surfaced in the report rather than hidden. */
  skippedLines: number;
  totalLines: number;
  /** Time range covered, for the report header. */
  firstTs: string | null;
  lastTs: string | null;
}

/** Mean of a numeric list, or null when the list is empty. */
function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** Group by a derived key and count. Sorted by count descending. */
function tally<T>(items: readonly T[], keyOf: (item: T) => string): { reason: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/**
 * Correlate a use with a suggestion.
 *
 * A use counts as an acceptance when the same session was suggested that capability within the
 * preceding window. Matching on session alone would attribute a later unrelated use; matching on
 * the capability alone would cross sessions.
 */
export function matchUsage(
  routes: readonly RouteEvent[],
  uses: readonly CapabilityUsedEvent[],
): { matched: Set<number>; unmatched: number; unobserved: number } {
  const matched = new Set<number>();
  let unmatched = 0;
  let unobserved = 0;

  // Suggestions indexed by session, each with its timestamp, so the window check is cheap.
  const suggestions = new Map<string, { ts: number; id: string }[]>();
  for (const route of routes) {
    if (route.decision !== "injected" || route.primary === null) continue;
    const at = Date.parse(route.ts);
    if (Number.isNaN(at)) continue;
    const list = suggestions.get(route.sessionId) ?? [];
    list.push({ ts: at, id: route.primary });
    suggestions.set(route.sessionId, list);
  }

  uses.forEach((use, index) => {
    if (use.via === "unobserved") {
      unobserved += 1;
      return;
    }

    const at = Date.parse(use.ts);
    if (Number.isNaN(at)) {
      unmatched += 1;
      return;
    }

    const candidates = suggestions.get(use.sessionId) ?? [];
    const hit = candidates.some(
      (suggestion) =>
        suggestion.id === use.capabilityId &&
        at >= suggestion.ts &&
        at - suggestion.ts <= ACCEPTANCE_WINDOW_MS,
    );

    if (hit) matched.add(index);
    else unmatched += 1;
  });

  return { matched, unmatched, unobserved };
}

/** Compute every statistic the dashboard needs from a list of events. */
export function summarise(
  events: readonly TelemetryEvent[],
  counts: { skippedLines: number; totalLines: number },
): TelemetrySummary {
  const routes = events.filter((event): event is RouteEvent => event.kind === "route");
  const uses = events.filter(
    (event): event is CapabilityUsedEvent => event.kind === "capability-used",
  );

  const injected = routes.filter((route) => route.decision === "injected");
  const skipped = routes.filter((route) => route.decision === "skipped");
  const degraded = routes.filter((route) => route.decision === "degraded");
  const cacheHits = routes.filter((route) => route.cacheHit);

  const latencies = routes.map((route) => route.latencyMs).filter((value) => Number.isFinite(value));
  // `percentile` is a nearest-rank implementation: it expects ascending input and a fraction
  // between 0 and 1. Passing an unsorted array silently returns the element at the clamped rank,
  // which is a plausible-looking number from the wrong end of the distribution.
  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  const tokensIn = injected.map((route) => route.tokensIn).filter((v): v is number => v !== null);
  const tokensOut = injected.map((route) => route.tokensOut).filter((v): v is number => v !== null);

  const total = routes.length;
  const rate = (count: number): number => (total === 0 ? 0 : count / total);

  const { matched, unmatched, unobserved } = matchUsage(routes, uses);

  // Acceptance counts per capability, so the report can show which suggestions are actually taken.
  const acceptedByCapability = new Map<string, number>();
  uses.forEach((use, index) => {
    if (!matched.has(index)) return;
    acceptedByCapability.set(use.capabilityId, (acceptedByCapability.get(use.capabilityId) ?? 0) + 1);
  });

  const suggestedByCapability = new Map<string, number>();
  for (const route of injected) {
    if (route.primary === null) continue;
    suggestedByCapability.set(route.primary, (suggestedByCapability.get(route.primary) ?? 0) + 1);
  }

  const candidates: CandidateStat[] = [...suggestedByCapability.entries()]
    .map(([id, suggested]) => ({ id, suggested, accepted: acceptedByCapability.get(id) ?? 0 }))
    .sort((a, b) => b.suggested - a.suggested || a.id.localeCompare(b.id));

  const timestamps = events
    .map((event) => event.ts)
    .filter((ts) => !Number.isNaN(Date.parse(ts)))
    .sort();

  return {
    overview: {
      totalPrompts: total,
      injected: injected.length,
      skipped: skipped.length,
      degraded: degraded.length,
      injectionRate: rate(injected.length),
      abstentionRate: rate(skipped.length),
      degradeRate: rate(degraded.length),
      cacheHitRate: rate(cacheHits.length),
      sessions: new Set(events.map((event) => event.sessionId)).size,
    },
    operational: {
      p50: percentile(sortedLatencies, 0.5),
      p95: percentile(sortedLatencies, 0.95),
      p99: percentile(sortedLatencies, 0.99),
      meanLatencyMs: mean(latencies) ?? 0,
      meanTokensIn: mean(tokensIn),
      meanTokensOut: mean(tokensOut),
      degradeCauses: tally(degraded, (route) => route.reason),
      skipReasons: tally(skipped, (route) => route.reason),
    },
    adoption: {
      suggestions: injected.length,
      observedUses: uses.length - unobserved,
      unmatchedUses: unmatched,
      acceptanceRate: injected.length === 0 ? null : matched.size / injected.length,
      unobserved,
    },
    candidates,
    skippedLines: counts.skippedLines,
    totalLines: counts.totalLines,
    firstTs: timestamps[0] ?? null,
    lastTs: timestamps.at(-1) ?? null,
  };
}
