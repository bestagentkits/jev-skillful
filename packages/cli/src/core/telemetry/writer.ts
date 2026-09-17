/**
 * Appending telemetry events.
 *
 * The single most important property here is that **nothing in this module can throw**. Telemetry
 * runs on the hook's path, inside a user's agent session, on a two-second budget. A full disk, a
 * read-only state directory, a permission problem, or a serialisation bug must all be silent
 * no-ops. Losing a log line is an inconvenience; breaking someone's prompt is not acceptable.
 *
 * Writes are a single `appendFileSync` of one line. On POSIX a write of a small buffer to a file
 * opened `O_APPEND` is atomic, so two hooks writing at the same instant produce two intact lines
 * rather than one interleaved line. Lines are bounded well below any platform's atomic-write limit
 * for that reason, and any line that would exceed the bound is dropped rather than written.
 */

import { appendFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  MAX_CANDIDATE_IDS,
  MAX_LINE_BYTES,
  MAX_RANKING_ENTRIES,
  SCHEMA_VERSION,
  type CapabilityUsedEvent,
  type RouteEvent,
  type TelemetryEvent,
  type UsageSource,
} from "./events.js";
import { ensureDir } from "../hooks/json-merge.js";

/** Environment switch, mirroring the hook's own. */
export const TELEMETRY_DISABLE_ENV = "SKILLFUL_TELEMETRY";

export interface WriteOptions {
  /** Absolute path of the log. */
  filePath: string;
  /** Hard cap on writes, for the benchmark arms and for tests. */
  enabled?: boolean;
  now?: () => Date;
  /** Bounded extras written into the file after the event object. */
  maxLineBytes?: number;
}

/** True when telemetry has been switched off. */
export function isTelemetryDisabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const raw = env[TELEMETRY_DISABLE_ENV]?.trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "off" || raw === "no";
}

/**
 * Keep candidate and ranking lists bounded.
 *
 * A shortlist is around fifteen today, but the quota system is configurable and a user can raise it
 * arbitrarily. Bounding here means one event cannot grow without limit, which is what keeps the
 * append atomic and the log affordable to read.
 */
function bound<T>(items: T[], limit: number): T[] {
  return items.length > limit ? items.slice(0, limit) : items;
}

/** Build a `route` event from a routing result. */
export function buildRouteEvent(input: {
  result: {
    decision: { kind: string; reason?: string; detail?: string };
    shortlist: readonly string[];
    ranking: readonly { id: string; noul: number }[];
    primary?: { id: string; noneP: number; confidence: number; probability: number };
    latencyMs: number;
    cacheHit: boolean;
    promptChars: number;
    tokensIn?: number;
    tokensOut?: number;
  };
  runtime: string;
  sessionId: string;
  promptHash: string;
  catalogFingerprint: string;
  now?: Date;
}): RouteEvent {
  const decision = input.result.decision;
  const primary =
    decision.kind === "injected" && "primary" in input.result
      ? ((input.result as { primary?: { id: string } }).primary?.id ?? null)
      : null;

  return {
    v: SCHEMA_VERSION,
    kind: "route",
    ts: (input.now ?? new Date()).toISOString(),
    runtime: input.runtime,
    sessionId: input.sessionId,
    promptHash: input.promptHash,
    promptChars: input.result.promptChars,
    catalogFingerprint: input.catalogFingerprint,
    candidateCount: input.result.shortlist.length,
    candidateIds: bound([...input.result.shortlist], MAX_CANDIDATE_IDS),
    primary,
    noneP: input.result.primary?.noneP ?? null,
    confidence: input.result.primary?.confidence ?? null,
    ranking: bound(
      input.result.ranking.map((entry) => ({ id: entry.id, noul: entry.noul })),
      MAX_RANKING_ENTRIES,
    ),
    decision: decision.kind as RouteEvent["decision"],
    // `detail` carries the heuristic name or the degraded cause, which is what makes a failure
    // analysable later. It is a fixed vocabulary from the router, never free text from a prompt.
    reason: decision.reason ?? decision.detail ?? decision.kind,
    latencyMs: Math.round(input.result.latencyMs),
    cacheHit: input.result.cacheHit,
    tokensIn: input.result.tokensIn ?? null,
    tokensOut: input.result.tokensOut ?? null,
    error: decision.kind === "degraded" ? (decision.reason ?? "unknown") : null,
  };
}

/** Build a `capability-used` event. */
export function buildCapabilityUsedEvent(input: {
  capabilityId: string;
  runtime: string;
  sessionId: string;
  via: UsageSource;
  now?: Date;
}): CapabilityUsedEvent {
  return {
    v: SCHEMA_VERSION,
    kind: "capability-used",
    ts: (input.now ?? new Date()).toISOString(),
    runtime: input.runtime,
    sessionId: input.sessionId,
    capabilityId: input.capabilityId,
    via: input.via,
  };
}

/**
 * Append one event.
 *
 * Returns true when the line was written, false when it was skipped for any reason at all. The
 * caller is free to ignore the return value; nothing about routing depends on it.
 */
export function writeEvent(event: TelemetryEvent, options: WriteOptions): boolean {
  if (options.enabled === false) return false;

  let line: string;
  try {
    line = `${JSON.stringify(event)}\n`;
  } catch {
    // A circular structure or a BigInt should be impossible from these builders, but this module
    // does not get to assume that.
    return false;
  }

  const maxBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
  if (Buffer.byteLength(line, "utf8") > maxBytes) return false;

  try {
    ensureDir(path.dirname(options.filePath));
    appendFileSync(options.filePath, line, { encoding: "utf8", mode: 0o600 });
    return true;
  } catch {
    // A full disk, a read-only directory, or a permissions problem. None of these is worth
    // disturbing the agent session that triggered the event.
    return false;
  }
}

/** Current size of the log in bytes, or 0 when it does not exist. */
export function logSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

/** Ensure the state directory exists. Used by the report command, not by the hook. */
export function ensureStateDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Reported by the caller when it subsequently fails to write.
  }
}
