/**
 * The route cache, so a repeated prompt does not pay for a repeated round trip.
 *
 * Two rules shape this module and both come from failure modes rather than performance:
 *
 * - **A degraded result is never cached.** If the API is having a bad minute, caching the
 *   failure would freeze the degraded behaviour for the whole TTL, turning a transient
 *   outage into fifteen minutes of the hook doing nothing. A miss costs one request; a
 *   cached failure costs every prompt until it expires.
 * - **A cache that cannot be read or written is treated as empty.** The cache is an
 *   optimisation, so it must never be able to break a route. Corrupt file, permission
 *   problem, concurrent writer: all of it degrades to a miss.
 *
 * Writes are atomic for the same reason the config writes are: several agent sessions on one
 * machine can run hooks at the same instant.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RouteResult } from "../router/route.js";
import { writeJsonAtomic } from "./json-merge.js";

export const CACHE_VERSION = 1;

/** Fifteen minutes, as specified. Long enough to catch a retry, short enough to notice a fix. */
export const DEFAULT_TTL_MS = 15 * 60 * 1000;

/** Upper bound on stored entries. Older entries are dropped first once this is exceeded. */
export const DEFAULT_MAX_ENTRIES = 500;

export interface CachedRoute {
  result: RouteResult;
  /** Epoch milliseconds when this entry was written. */
  ts: number;
}

export interface CacheStore {
  version: number;
  entries: Record<string, CachedRoute>;
}

/** An empty store, used when there is no cache file or it cannot be parsed. */
export function emptyCache(): CacheStore {
  return { version: CACHE_VERSION, entries: {} };
}

/**
 * Normalise a prompt so that trivial rewordings share a cache entry.
 *
 * Case and whitespace are the only things collapsed. Anything more aggressive would start
 * conflating genuinely different tasks, and a wrong cache hit is a wrong routing decision
 * that no metric would catch.
 */
export function normalisePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Cache key: the normalised prompt plus the catalog fingerprint.
 *
 * The fingerprint is part of the key so that installing a skill, removing an MCP server, or
 * editing a description invalidates every entry that was routed against the old catalog.
 * Without it, the cache would happily serve decisions made against a catalog that no longer
 * exists.
 */
export function routeCacheKey(prompt: string, catalogFingerprint: string): string {
  return createHash("sha256")
    .update(`${normalisePrompt(prompt)}|${catalogFingerprint}`)
    .digest("hex");
}

/** Read the cache, returning an empty store for any problem including a missing file. */
export function loadCache(cachePath: string): CacheStore {
  let raw: string;
  try {
    raw = readFileSync(cachePath, "utf8");
  } catch {
    return emptyCache();
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return emptyCache();
    const candidate = parsed as Partial<CacheStore>;
    if (candidate.version !== CACHE_VERSION) return emptyCache();
    if (typeof candidate.entries !== "object" || candidate.entries === null) return emptyCache();

    const entries: Record<string, CachedRoute> = {};
    for (const [key, value] of Object.entries(candidate.entries)) {
      const entry = value as Partial<CachedRoute> | undefined;
      if (entry === undefined || typeof entry !== "object" || entry === null) continue;
      if (typeof entry.ts !== "number") continue;
      if (entry.result === undefined || entry.result === null) continue;
      entries[key] = { result: entry.result, ts: entry.ts };
    }
    return { version: CACHE_VERSION, entries };
  } catch {
    return emptyCache();
  }
}

/** Persist the cache. Failures are swallowed: the cache must never break a route. */
export function saveCache(cachePath: string, store: CacheStore): void {
  try {
    writeJsonAtomic(cachePath, store);
  } catch {
    // A hook that cannot write its cache is still a working hook.
  }
}

/**
 * Look up a decision.
 *
 * Expired entries are reported as a miss and left in place for `prune` to remove, so that a
 * read never has to write.
 */
export function cacheGet(
  store: CacheStore,
  key: string,
  options: { ttlMs?: number; now?: number } = {},
): RouteResult | undefined {
  const entry = store.entries[key];
  if (entry === undefined) return undefined;

  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now();
  if (now - entry.ts > ttlMs) return undefined;

  return entry.result;
}

/**
 * Store a decision.
 *
 * Refuses to store anything that is not a resolved decision. A degraded result means "we do
 * not know", and caching it would convert a momentary failure into a sustained one.
 */
export function cacheSet(
  store: CacheStore,
  key: string,
  result: RouteResult,
  options: { now?: number } = {},
): boolean {
  if (result.decision.kind === "degraded") return false;
  store.entries[key] = { result, ts: options.now ?? Date.now() };
  return true;
}

/**
 * Drop expired entries and enforce the size cap, oldest first.
 *
 * Returns a new store rather than mutating, so a caller can write the result back knowing
 * exactly what changed.
 */
export function pruneCache(
  store: CacheStore,
  options: { ttlMs?: number; maxEntries?: number; now?: number } = {},
): CacheStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? Date.now();

  const live = Object.entries(store.entries)
    .filter(([, entry]) => now - entry.ts <= ttlMs)
    .sort(([, a], [, b]) => b.ts - a.ts)
    .slice(0, maxEntries);

  return { version: CACHE_VERSION, entries: Object.fromEntries(live) };
}
