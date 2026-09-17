/**
 * The telemetry event schema.
 *
 * Two rules govern everything here, and both come from the analysis phase 7 has to perform rather
 * than from a preference for tidy data.
 *
 * **The log must be sufficient to reconstruct a paired analysis.** The measured question is
 * whether injection actually helps, compared on the *same* task with and without it. That cannot be
 * reconstructed from a decision count: it needs the prompt identity, the catalog identity, the
 * shortlist, the decision, and the reason. Anything less and the log records that something
 * happened without recording enough to say what it did.
 *
 * **`capability-used` has to be a separate event.** If the log only records routing, a poor
 * outcome cannot be attributed: it is either "the router chose wrong" or "the agent ignored a fine
 * suggestion", and those need completely different fixes. The second event is what separates them.
 *
 * Nothing here carries prompt text, an API key, or an environment value. The prompt is represented
 * by a hash and a length, which is enough to correlate and not enough to read.
 */

export const SCHEMA_VERSION = 1;

/** Where a `capability-used` observation came from, and whether it was observed at all. */
export const USAGE_SOURCES = [
  "skill-invoked",
  "tool-call",
  "post-tool-use",
  "unobserved",
] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

export const ROUTE_DECISIONS = ["injected", "skipped", "degraded"] as const;
export type RouteDecisionKind = (typeof ROUTE_DECISIONS)[number];

export interface RankingEntry {
  id: string;
  noul: number;
}

export interface RouteEvent {
  v: number;
  kind: "route";
  /** ISO 8601, UTC. */
  ts: string;
  runtime: string;
  sessionId: string;
  promptHash: string;
  promptChars: number;
  catalogFingerprint: string;
  candidateCount: number;
  candidateIds: string[];
  primary: string | null;
  noneP: number | null;
  confidence: number | null;
  ranking: RankingEntry[];
  decision: RouteDecisionKind;
  reason: string;
  latencyMs: number;
  cacheHit: boolean;
  tokensIn: number | null;
  tokensOut: number | null;
  error: string | null;
}

export interface CapabilityUsedEvent {
  v: number;
  kind: "capability-used";
  ts: string;
  runtime: string;
  sessionId: string;
  capabilityId: string;
  via: UsageSource;
}

export type TelemetryEvent = RouteEvent | CapabilityUsedEvent;

/** Bounds so that one event can never become a large write. */
export const MAX_CANDIDATE_IDS = 40;
export const MAX_RANKING_ENTRIES = 20;
/** A single line over this many bytes is dropped rather than written. */
export const MAX_LINE_BYTES = 16 * 1024;

/**
 * Validate one parsed value as an event.
 *
 * Unknown extra fields are tolerated, because a newer version's events must not break an older
 * reader. Missing required fields are not: a half-written event is worse than a dropped one,
 * because it silently contributes a wrong number to a rate.
 */
export function isTelemetryEvent(value: unknown): value is TelemetryEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;

  if (typeof event["ts"] !== "string") return false;
  if (typeof event["runtime"] !== "string") return false;
  if (typeof event["sessionId"] !== "string") return false;

  if (event["kind"] === "capability-used") {
    return typeof event["capabilityId"] === "string" && typeof event["via"] === "string";
  }

  if (event["kind"] !== "route") return false;

  return (
    typeof event["promptHash"] === "string" &&
    typeof event["decision"] === "string" &&
    typeof event["latencyMs"] === "number" &&
    Array.isArray(event["candidateIds"])
  );
}

/** Numeric field access that treats a missing or non-numeric value as null. */
export function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
