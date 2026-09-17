/**
 * The hook's decision path: prompt in, injection text out, and never a thrown error.
 *
 * This is the code that runs on every single prompt the user types, inside their agent, with a
 * two-second budget. Three rules dominate the design:
 *
 * 1. **Nothing escapes.** Every failure — no key, bad config, dead network, unreadable catalog,
 *    exhausted budget — produces a valid, injectable-or-empty answer. A hook that crashes the
 *    host agent is worse than a hook that suggests nothing, so the guarantee is enforced by a
 *    top-level catch here rather than trusted to each layer.
 * 2. **The budget is the ceiling, not the target.** Catalog scanning and routing share one
 *    deadline. If the scan alone eats it, the route is abandoned rather than started late.
 * 3. **Degrading never costs the user their prompt.** A degraded run injects one short
 *    reminder or nothing at all; it never blocks, never retries indefinitely, never prints.
 *
 * `SKILLFUL_DISABLE=1` short-circuits before any work, which is also the control arm the
 * outcome benchmark uses in phase 7.
 */

import type { Catalog, CatalogEntry } from "../catalog/types.js";
import { resolveConfig, type ResolvedConfig } from "../config/resolve.js";
import { route, type RouteResult } from "../router/route.js";
import { DEFAULT_MAX_ENTRIES, DEFAULT_TTL_MS, loadCache, pruneCache, routeCacheKey, saveCache, cacheGet, cacheSet } from "./cache.js";
import { DEGRADED_REMINDER, degradedReminder } from "./degrade.js";
import { renderInjection } from "./render.js";

/** Environment variable that turns the hook off entirely, with no other effect. */
export const DISABLE_ENV = "SKILLFUL_DISABLE";

export interface HookInput {
  prompt: string;
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
}

/** The stdout shape Claude Code and Codex both accept. */
export interface HookPayload {
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext: string;
  };
}

export interface HookDeps {
  homeDir: string;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Injected so tests never touch the real machine. */
  scan: (options: { homeDir: string; cwd: string; env: Readonly<Record<string, string | undefined>> }) => Promise<Catalog>;
  /** Injected so tests can supply recorded responses. */
  routeFn?: typeof route;
  /** Route cache location. Defaults to `~/.cache/skillful/routes.json`. */
  cachePath?: string;
  now?: () => number;
}

export interface HookOutcome {
  /** Exactly what to print. `{}` when there is nothing to inject. */
  payload: HookPayload;
  /** The routing result, when one was produced. Absent for disabled or failed runs. */
  result?: RouteResult;
  cacheHit: boolean;
  /** True when the run could not produce a decision. */
  degraded: boolean;
  /** Human-readable reason, for `doctor` and telemetry. Never printed by the hook. */
  reason?: string;
  elapsedMs: number;
}

/**
 * Decide what a hook should inject for one prompt.
 *
 * Returns a value in every case. The only way this function does not return normally is if the
 * process is killed.
 */
export async function runHook(input: HookInput, deps: HookDeps): Promise<HookOutcome> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const event = input.hook_event_name ?? "UserPromptSubmit";

  const empty = (reason: string, degraded: boolean): HookOutcome => ({
    payload: {},
    cacheHit: false,
    degraded,
    reason,
    elapsedMs: now() - startedAt,
  });

  try {
    if (isDisabled(deps.env)) return empty("disabled via SKILLFUL_DISABLE", false);

    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    if (prompt.trim().length === 0) return empty("empty prompt", false);

    const resolved = resolveConfig({ env: deps.env, homeDir: deps.homeDir });
    const { config } = resolved;

    // A missing key is the expected state for a user who has not set one up, so it degrades
    // quietly instead of erroring. The reminder text tells them what to run.
    const apiKey = deps.env["TYPESAFE_API_KEY"];
    if (apiKey === undefined || apiKey.trim().length === 0) {
      return {
        payload: injectionPayload(event, DEGRADED_REMINDER),
        cacheHit: false,
        degraded: true,
        reason: "no API key",
        elapsedMs: now() - startedAt,
      };
    }

    let catalog: Catalog;
    try {
      catalog = await deps.scan({ homeDir: deps.homeDir, cwd: deps.cwd, env: deps.env });
    } catch (error) {
      return empty(`catalog scan failed: ${(error as Error).message}`, true);
    }

    const cachePath = deps.cachePath ?? defaultCachePath(deps.homeDir);
    const key = routeCacheKey(prompt, catalog.fingerprint);

    // Cache first: a hit costs a file read instead of a round trip, which is the difference
    // between a 5ms hook and a 700ms one.
    const store = loadCache(cachePath);
    const cached = cacheGet(store, key, { ttlMs: DEFAULT_TTL_MS, now: now() });
    if (cached !== undefined) {
      const text = renderInjection(cached);
      return {
        payload: text === null ? {} : injectionPayload(event, text),
        result: cached,
        cacheHit: true,
        degraded: false,
        elapsedMs: now() - startedAt,
      };
    }

    const result = await (deps.routeFn ?? route)(prompt, {
      entries: catalog.entries,
      thresholds: config.thresholds,
      quotaGroups: config.quotaGroups,
      model: config.model,
      baseUrl: config.baseUrl,
      uploadPrompt: config.uploadPrompt,
    });

    // Only resolved decisions are cached. Caching a degraded result would turn a momentary
    // outage into a fifteen-minute one.
    if (cacheSet(store, key, result, { now: now() })) {
      saveCache(
        cachePath,
        pruneCache(store, { ttlMs: DEFAULT_TTL_MS, maxEntries: DEFAULT_MAX_ENTRIES, now: now() }),
      );
    }

    if (result.decision.kind === "degraded") {
      return {
        payload: injectionPayload(event, degradedReminder()),
        result,
        cacheHit: false,
        degraded: true,
        reason: result.decision.reason,
        elapsedMs: now() - startedAt,
      };
    }

    const text = renderInjection(result);
    return {
      payload: text === null ? {} : injectionPayload(event, text),
      result,
      cacheHit: false,
      degraded: false,
      elapsedMs: now() - startedAt,
    };
  } catch (error) {
    // The last line of defence. Reaching here means a bug, and the user still gets a working
    // agent: no output, exit 0, nothing on stderr.
    return {
      payload: {},
      cacheHit: false,
      degraded: true,
      reason: `unexpected hook failure: ${(error as Error).message}`,
      elapsedMs: now() - startedAt,
    };
  }
}

/** True when the user has switched the hook off. */
export function isDisabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const raw = env[DISABLE_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** Build the stdout payload, or `{}` when there is nothing worth saying. */
export function injectionPayload(event: string, text: string): HookPayload {
  if (text.length === 0) return {};
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

/** `~/.cache/skillful/routes.json`, honouring `XDG_CACHE_HOME`. */
export function defaultCachePath(homeDir: string): string {
  return `${homeDir}/.cache/skillful/routes.json`;
}

/** Extracted so `doctor` can report which config was used without re-resolving it. */
export function resolveForReport(
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
): ResolvedConfig {
  return resolveConfig({ env, homeDir });
}

/** Re-exported so callers can count entries without reaching into the catalog module. */
export type { CatalogEntry };
