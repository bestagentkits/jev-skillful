/**
 * Shortlist construction: BM25 within a kind group, then a quota per group.
 *
 * Ranking everything together would let a large kind drown out a small one — a machine
 * with 174 Oh My Pi skills and 2 MCP servers would send 15 skills to the model and never
 * mention the servers. Quotas fix the composition of what the model sees.
 */

import { rankBm25, type ScoredDoc } from "./bm25.js";
import type { CatalogEntry, CatalogKind, CatalogRuntime } from "../catalog/types.js";

/**
 * A quota applies to a set of kinds that compete for the same slots.
 *
 * `command` and `rule` share one quota on purpose: both are small, narrow surfaces and
 * giving each its own budget would crowd out agents and MCP servers.
 */
export interface QuotaGroup {
  kinds: readonly CatalogKind[];
  limit: number;
}

export const DEFAULT_QUOTA_GROUPS: readonly QuotaGroup[] = [
  { kinds: ["skill"], limit: 6 },
  { kinds: ["mcp"], limit: 4 },
  { kinds: ["agent"], limit: 3 },
  { kinds: ["command", "rule"], limit: 2 },
];

/** K, the number of candidates the model is asked about. */
export const DEFAULT_SHORTLIST_SIZE = DEFAULT_QUOTA_GROUPS.reduce(
  (sum, group) => sum + group.limit,
  0,
);

/**
 * A second copy of the same capability, installed under a different runtime root.
 *
 * Kept on the candidate rather than discarded, because the runtime hook in phase 4 needs
 * the path that matches the runtime it is running inside.
 */
export interface ShortlistAlternate {
  runtime: CatalogRuntime;
  sourcePath: string;
}

export interface ShortlistEntry {
  id: string;
  kind: CatalogKind;
  score: number;
  entry: CatalogEntry;
  /** Other installed copies of this same capability. */
  alternates: ShortlistAlternate[];
}

export interface ShortlistGroupResult {
  kinds: readonly CatalogKind[];
  limit: number;
  /** How many candidates this group contributed, which is `limit` unless it ran short. */
  selected: number;
  /** True when the group had more distinct matches than its quota allowed. */
  truncated: boolean;
  /** Candidates dropped because an indistinguishable copy was already selected. */
  duplicatesRemoved: number;
}

export interface Shortlist {
  entries: ShortlistEntry[];
  groups: ShortlistGroupResult[];
}

export interface ShortlistOptions {
  /**
   * Minimum BM25 score for a candidate to be included.
   *
   * The default of zero keeps every scored document, including ones that share no term
   * with the query. That is deliberate: a zero-match query still gives the model a chance
   * to say `none`, and the alternative — sending an empty shortlist — turns ordinary
   * vocabulary mismatch into a silent routing failure.
   */
  minScore?: number;
}

/**
 * Build the shortlist: one BM25 ranking per quota group, cut to that group's limit.
 *
 * Leftover quota is deliberately **not** redistributed to other groups. If a machine has
 * no MCP servers, the shortlist is smaller rather than filled with extra skills. That
 * keeps the composition predictable and stops an absent kind from quietly changing how
 * the skill quota behaves.
 */
export function buildShortlist(
  entries: readonly CatalogEntry[],
  query: string,
  groups: readonly QuotaGroup[] = DEFAULT_QUOTA_GROUPS,
  options: ShortlistOptions = {},
): Shortlist {
  const minScore = options.minScore ?? 0;
  const selected: ShortlistEntry[] = [];
  const groupResults: ShortlistGroupResult[] = [];

  for (const group of groups) {
    const members = entries.filter((entry) => group.kinds.includes(entry.kind));
    // `whenToUse` is included because it is routing-intent text written for exactly this
    // decision. Adding it moved recall@K from 0.765 to 0.804 on the development fixtures and
    // from 0.500 to 0.600 on the holdout set, and it is present on 203 of 230 skills.
    const docs = members.map((entry) => ({
      id: entry.id,
      text: searchableText(entry),
    }));
    const byId = new Map(members.map((entry) => [entry.id, entry]));
    const ranked = rankBm25(docs, query).filter((hit) => hit.score >= minScore);

    // Collapsing before the quota cut means a slot freed by a duplicate goes to a
    // genuinely different capability instead of being wasted.
    const distinct = collapseIndistinguishable(ranked, byId);
    const taken = distinct.slice(0, group.limit);
    selected.push(...taken);

    groupResults.push({
      kinds: group.kinds,
      limit: group.limit,
      selected: taken.length,
      truncated: distinct.length > group.limit,
      duplicatesRemoved: ranked.length - distinct.length,
    });
  }

  // Groups are already in quota order, so ranking the combined list would reorder them.
  // Best-scoring first is the more useful presentation for `--explain`, and the model
  // receives candidates in a stable request order regardless.
  selected.sort((x, y) => (y.score - x.score) || (x.id < y.id ? -1 : 1));

  return { entries: selected, groups: groupResults };
}

/**
 * The text BM25 scores a capability against.
 *
 * Name, description and routing-intent text together. The name is included because it is often
 * the only meaningful token an entry has — an MCP server's description is the infrastructure
 * string read from a config file, while its name says what it is.
 */
export function searchableText(entry: CatalogEntry): string {
  return `${entry.name} ${entry.description} ${entry.whenToUse ?? ""}`.trim();
}

/**
 * Collapse candidates the model cannot tell apart.
 *
 * The same capability is often installed under more than one runtime root. On the machine
 * this was built on, `~/.claude/skills/ak-backend-development/SKILL.md` and
 * `~/.agents/skills/ak-backend-development/SKILL.md` are two distinct files with
 * byte-identical descriptions that differ only in the name convention
 * (`ak:backend-development` against `ak-backend-development`).
 *
 * Retrieval scores them identically, so both reach the shortlist, and the model then picks
 * one as primary and the other as runner-up — the same skill injected twice, which is
 * exactly the redundancy the injection limit exists to avoid. The description is the only
 * text the model sees to choose from, so two same-kind candidates with an identical
 * description are one option by construction.
 *
 * Ranked order is best-first, so the representative is the first occurrence and every
 * later copy becomes an alternate path on it.
 */
function collapseIndistinguishable(
  ranked: readonly ScoredDoc[],
  byId: ReadonlyMap<string, CatalogEntry>,
): ShortlistEntry[] {
  const seen = new Map<string, ShortlistEntry>();
  const collapsed: ShortlistEntry[] = [];

  for (const hit of ranked) {
    const entry = byId.get(hit.id);
    if (entry === undefined) continue;

    // Kind is part of the key: a skill and an MCP server described the same way are still
    // different things and must both be offered.
    const key = `${entry.kind}\u0000${entry.description}`;
    const existing = seen.get(key);

    if (existing === undefined) {
      const created: ShortlistEntry = {
        id: entry.id,
        kind: entry.kind,
        score: hit.score,
        entry,
        alternates: [],
      };
      seen.set(key, created);
      collapsed.push(created);
      continue;
    }

    existing.alternates.push({ runtime: entry.runtime, sourcePath: entry.sourcePath });
  }

  return collapsed;
}
