/**
 * Eval corpus: a frozen snapshot of a real catalog, used as the distractor set.
 *
 * SRA-Bench mixes gold capabilities with distractors collected from the web, and notes that
 * a fixture containing only gold items makes the retrieval stage artificially easy. The
 * cheapest and most faithful distractor set available is the catalog of the machine the
 * eval was captured on: those are real capabilities, really installed, with the real
 * near-misses that make retrieval hard — 268 distinct skill names, of which several are
 * near-duplicates of one another by construction.
 *
 * The snapshot is pinned to a file so the numbers in a report can be reproduced later even
 * after the machine's catalog has changed.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { CatalogEntry } from "../catalog/types.js";

/**
 * Markers identifying a capability as specific to this machine's owner rather than public.
 *
 * This repository is public, and a capability name is not neutral metadata: a name such as a
 * production cutover, a staging host, or a customer migration step discloses infrastructure
 * topology and operational history. The eval corpus exists to be committed and reproduced, so
 * these entries are removed from the committed snapshot by default.
 *
 * The list is a denylist, and a denylist can miss something. It is reported as a filter that
 * ran, not as a guarantee, and anyone publishing an artifact derived from a sanitised corpus
 * should still read the corpus once first.
 *
 * Matching is case-insensitive and covers the name **and** the description, because an
 * innocuously named capability can name a private project in its description.
 */
export const PRIVATE_MARKERS: readonly string[] = [
  "dewee",
  "zuey",
  "nlb-web",
  "cloud-harness",
  "cloudharness",
  "goclaw",
  "incus",
  "designstudio",
  "agentwiki",
  "posthog",
  "agentkit-runtime",
  "agentkit-add",
  "agentkit-author",
  "agentkit-git-push",
  "agentkit-guarded",
  "agentkit-ship",
  "agentkit-ultra",
  "promote-agentkit",
  "ship-dsa-feature-parity",
  "dsa-feature-parity",
  "postgres-docker-to-k8s-cutover",
  "live-prod-db-cutover",
  "exact-capacity-atomic-admission",
  "diagnose-shadowed-cli-command",
];

/**
 * Short markers need a word boundary.
 *
 * A plain `orca` substring matches `orchestration`, which is a public AgentKit skill, so the
 * boundary is not cosmetic — without it the sanitiser silently deletes legitimate entries.
 */
const PRIVATE_PATTERNS: readonly RegExp[] = [/\borca[-/]/i, /\btally\b/i];

/** True when an entry is safe to publish in the committed eval corpus. */
export function isPublicSafe(entry: CatalogEntry): boolean {
  const haystack = `${entry.name} ${entry.description}`.toLowerCase();
  if (PRIVATE_MARKERS.some((marker) => haystack.includes(marker))) return false;
  return !PRIVATE_PATTERNS.some((pattern) => pattern.test(haystack));
}

/**
 * Infrastructure identifiers that must not be published, wherever they appear.
 *
 * A denylist of project names cannot catch a leak that lives inside a URL or a path, which is
 * exactly how one slipped through the first time: an MCP server's description read
 * `MCP server (http): https://<tenant>-mcp-staging.<account>.workers.dev/mcp`, naming a
 * staging tenant and account. The entry name was innocuous, so no marker matched it.
 *
 * Redaction runs before the marker filter and rewrites the description rather than dropping
 * the entry, so the corpus keeps its size and composition while losing the identifier.
 */
/**
 * Path and URL patterns allow spaces and stop at a line break, quote or bracket.
 *
 * A pattern that stopped at whitespace left the tail of any path containing a space behind —
 * `./Codex Computer Use.app/...` became `[path] Contents/...` — and a real path in prose, such
 * as `/Applications/My App.app/bin`, was cut in half the same way. Allowing spaces risks
 * redacting a little more of a description than strictly necessary, which is the correct
 * direction to fail for a filter whose job is to remove infrastructure identifiers.
 */
const URL_PATTERN = /https?:\/\/[^\n"\])}]+/g;
const ABSOLUTE_PATH_PATTERN = /\/(?:Users|home|var|opt|srv|Applications)\/[^\n"\])}]*/g;
const HOME_PATH_PATTERN = /~\/[^\n"\])}]*/g;
/** A relative path into an application bundle, which names installed software. */
const BUNDLE_PATH_PATTERN = /\.\/[^\n"\])}]*?\.app\/[^\n"\])}]*/g;

/**
 * The catalog writes an MCP entry's description as `MCP server (<transport>): <target>`, where
 * the target is a URL or a command line.
 *
 * Both are infrastructure. A URL names a tenant and an account; a command line names installed
 * applications and their bundle paths. The payload is replaced wholesale rather than parsed,
 * because a path-based regex kept losing to spaces in bundle names such as
 * `./Codex Computer Use.app/...`, and every byte of the payload is machine-specific anyway.
 */
const MCP_TARGET_PATTERN = /(MCP server \([^)]*\):).*$/gm;

/** Replace URLs, filesystem paths and MCP targets in a description with placeholders. */
export function redactInfrastructure(text: string): string {
  return text
    .replace(MCP_TARGET_PATTERN, "$1 [redacted]")
    .replace(URL_PATTERN, "[url]")
    .replace(ABSOLUTE_PATH_PATTERN, "[path]")
    .replace(HOME_PATH_PATTERN, "[path]")
    .replace(BUNDLE_PATH_PATTERN, "[path]");
}

/**
 * Collapse a home directory prefix to `~`, keeping the rest of the path.
 *
 * An absolute path names the machine's user, which is identity information with no
 * evaluation value. The structure after the prefix is kept because it is useful — it says
 * which runtime root an entry came from — and the layout of `~/.claude` and `~/.codex` is
 * public knowledge.
 */
export function collapseHomePrefix(filePath: string): string {
  return filePath.replace(/^(?:\/Users|\/home)\/[^/]+/, "~");
}

/** True when a description still carries an infrastructure identifier. */
export function hasInfrastructureIdentifier(text: string): boolean {
  return (
    /https?:\/\//.test(text) ||
    /\/(?:Users|home|var|opt|srv|Applications)\//.test(text) ||
    /~\//.test(text) ||
    /\.app\//.test(text) ||
    /MCP server \([^)]*\):\s*\S/.test(text)
  );
}

/**
 * Split a catalog into publishable entries and the number withheld.
 *
 * Three separate leaks had to be closed here, and the first attempt closed only one of them:
 *
 * 1. Project names in the entry name or description — handled by the marker filter.
 * 2. Infrastructure identifiers inside a description, which a name-based denylist cannot see.
 * 3. The same identifiers in fields the filter never touched. `sourcePath` carried
 *    `/Users/<user>/...` on every one of 533 entries, and MCP `meta` carried two private
 *    service URLs and local application paths. The router does not read `meta` at all, so it
 *    is dropped rather than redacted.
 */
export function sanitiseCorpus(entries: readonly CatalogEntry[]): {
  kept: CatalogEntry[];
  excludedCount: number;
  redactedCount: number;
} {
  const kept: CatalogEntry[] = [];
  let redactedCount = 0;

  for (const entry of entries) {
    if (!isPublicSafe(entry)) continue;

    const description = redactInfrastructure(entry.description);
    const sourcePath = collapseHomePrefix(entry.sourcePath);
    const changed =
      description !== entry.description ||
      sourcePath !== entry.sourcePath ||
      entry.meta !== undefined;
    if (changed) redactedCount += 1;

    // Rebuilt field by field, deliberately omitting `meta`: it is not used by retrieval or
    // routing, and it is where a connection URL or a local command path lives.
    const next: CatalogEntry = {
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      description,
      runtime: entry.runtime,
      scope: entry.scope,
      sourcePath,
    };
    if (entry.degraded !== undefined) next.degraded = entry.degraded;
    kept.push(next);
  }

  return { kept, excludedCount: entries.length - kept.length, redactedCount };
}

export interface CorpusSnapshot {
  /** ISO timestamp of when the snapshot was taken. */
  capturedAt: string;
  /** Catalog fingerprint, so a report can be tied to an exact catalog state. */
  fingerprint: string;
  /**
   * True when private entries were removed.
   *
   * Recorded in the file so a reader can distinguish a filtered corpus from a complete one. A
   * filtered corpus is a marginally easier retrieval problem, because some near-misses are
   * gone, and a report should not present it as the full machine catalog.
   */
  sanitised: boolean;
  /** How many entries were withheld. Names are deliberately not recorded. */
  excludedCount: number;
  /** How many descriptions had a URL or filesystem path replaced with a placeholder. */
  redactedCount: number;
  entries: CatalogEntry[];
}

export function saveCorpus(
  filePath: string,
  entries: readonly CatalogEntry[],
  fingerprint: string,
  options: { sanitise?: boolean; capturedAt?: string } = {},
): CorpusSnapshot {
  const sanitise = options.sanitise ?? false;
  const { kept, excludedCount, redactedCount } = sanitise
    ? sanitiseCorpus(entries)
    : { kept: [...entries], excludedCount: 0, redactedCount: 0 };

  const snapshot: CorpusSnapshot = {
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    fingerprint,
    sanitised: sanitise,
    excludedCount,
    redactedCount,
    entries: kept,
  };
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return snapshot;
}

export function loadCorpus(filePath: string): CorpusSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new Error(`${filePath}: corpus snapshot is not readable JSON (${reason})`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${filePath}: corpus snapshot must be a JSON object`);
  }

  const record = parsed as Partial<CorpusSnapshot>;
  if (!Array.isArray(record.entries)) {
    throw new Error(`${filePath}: corpus snapshot has no entries array`);
  }

  return {
    capturedAt: typeof record.capturedAt === "string" ? record.capturedAt : "unknown",
    fingerprint: typeof record.fingerprint === "string" ? record.fingerprint : "unknown",
    // An older snapshot without these fields predates sanitisation, so it is treated as a
    // complete corpus rather than silently reported as filtered.
    sanitised: record.sanitised === true,
    excludedCount: typeof record.excludedCount === "number" ? record.excludedCount : 0,
    redactedCount: typeof record.redactedCount === "number" ? record.redactedCount : 0,
    entries: record.entries,
  };
}
