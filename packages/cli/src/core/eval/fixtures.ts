/**
 * Eval fixture format, parsing and validation.
 *
 * A fixture states what the router *should* do for one prompt. Gold is written as a
 * capability **name** rather than an id, because ids embed the runtime and the same
 * capability is usually installed under several. A name resolves to every id that carries
 * it, and the router counts as correct if it picks any of them. That is the honest
 * requirement: which runtime's copy got injected does not change whether the task succeeded.
 */

import type { CatalogEntry, CatalogKind } from "../catalog/types.js";

export const FIXTURE_GROUPS = [
  "coding",
  "marketing",
  "mcp",
  "agent",
  "trivial",
  "ambiguous",
  "vietnamese",
] as const;

export type FixtureGroup = (typeof FIXTURE_GROUPS)[number];

/** Gold value meaning "the router must inject nothing". */
export const ABSTAIN = "none";

export interface Fixture {
  id: string;
  group: FixtureGroup;
  prompt: string;
  /** Capability names or ids, or `["none"]` when the router must abstain. */
  gold: string[];
  notes?: string;
}

export interface ResolvedFixture extends Fixture {
  /** Canonical ids, any one of which counts as a correct pick. Empty for an abstain fixture. */
  goldIds: string[];
  /** Kinds of the gold capabilities, for per-kind reporting. */
  goldKinds: CatalogKind[];
  expectAbstain: boolean;
}

export class FixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureError";
  }
}

/**
 * Parse a JSONL fixture file.
 *
 * Blank lines and lines starting with `#` are ignored so a fixture file can carry section
 * headers. Every error names the source and the line number, because a fixture typo that
 * silently drops a case would quietly weaken the gate this whole phase exists to enforce.
 */
export function parseFixtures(text: string, source = "<inline>"): Fixture[] {
  const fixtures: Fixture[] = [];
  const seen = new Map<string, number>();

  text.split("\n").forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new FixtureError(`${source}:${lineNumber}: not valid JSON`);
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new FixtureError(`${source}:${lineNumber}: expected a JSON object`);
    }

    const record = parsed as Record<string, unknown>;
    const id = record["id"];
    const group = record["group"];
    const prompt = record["prompt"];
    const gold = record["gold"];

    if (typeof id !== "string" || id.trim().length === 0) {
      throw new FixtureError(`${source}:${lineNumber}: missing or empty "id"`);
    }
    if (seen.has(id)) {
      throw new FixtureError(`${source}:${lineNumber}: duplicate id "${id}", first seen on line ${seen.get(id) ?? 0}`);
    }
    seen.set(id, lineNumber);

    if (typeof group !== "string" || !FIXTURE_GROUPS.includes(group as FixtureGroup)) {
      throw new FixtureError(
        `${source}:${lineNumber}: group must be one of ${FIXTURE_GROUPS.join(", ")}, got ${JSON.stringify(group)}`,
      );
    }
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      throw new FixtureError(`${source}:${lineNumber}: missing or empty "prompt"`);
    }
    if (!Array.isArray(gold) || gold.length === 0 || !gold.every((item) => typeof item === "string")) {
      throw new FixtureError(`${source}:${lineNumber}: "gold" must be a non-empty array of strings`);
    }
    if (gold.includes(ABSTAIN) && gold.length > 1) {
      throw new FixtureError(`${source}:${lineNumber}: "${ABSTAIN}" cannot be combined with other gold values`);
    }

    const notes = record["notes"];
    fixtures.push({
      id,
      group: group as FixtureGroup,
      prompt,
      gold: gold as string[],
      ...(typeof notes === "string" ? { notes } : {}),
    });
  });

  return fixtures;
}

/**
 * Normalise a capability name for gold matching.
 *
 * The same skill is named with a colon on one runtime and a hyphen on another, because the
 * name comes from whichever runtime wrote the frontmatter: `ak:debug` next to `ak-debug`.
 * The shortlist already treats such copies as a single candidate, so gold matching has to
 * agree — otherwise a correct pick is scored as a miss purely because the other runtime's
 * copy was the one selected.
 *
 * Lowercasing is applied for the same reason: capability names are identifiers and are not
 * meaningfully case-sensitive.
 */
export function normaliseGoldName(name: string): string {
  return name.replace(/:/g, "-").toLowerCase();
}

/** Index a catalog by id, by exact name, and by convention-normalised name. */
export function buildGoldIndex(entries: readonly CatalogEntry[]): {
  byId: Map<string, CatalogEntry>;
  byName: Map<string, CatalogEntry[]>;
  byNormalisedName: Map<string, CatalogEntry[]>;
} {
  const byId = new Map<string, CatalogEntry>();
  const byName = new Map<string, CatalogEntry[]>();
  const byNormalisedName = new Map<string, CatalogEntry[]>();

  for (const entry of entries) {
    byId.set(entry.id, entry);

    const bucket = byName.get(entry.name);
    if (bucket === undefined) {
      byName.set(entry.name, [entry]);
    } else {
      bucket.push(entry);
    }

    const key = normaliseGoldName(entry.name);
    const normalised = byNormalisedName.get(key);
    if (normalised === undefined) {
      byNormalisedName.set(key, [entry]);
    } else {
      normalised.push(entry);
    }
  }

  return { byId, byName, byNormalisedName };
}

/**
 * Resolve gold tokens against the eval corpus.
 *
 * A token that resolves to nothing is an error, not a skip. A gold capability that has
 * disappeared from the catalog means the fixture no longer measures what it claims to.
 */
export function resolveFixtures(
  fixtures: readonly Fixture[],
  entries: readonly CatalogEntry[],
): ResolvedFixture[] {
  const index = buildGoldIndex(entries);

  return fixtures.map((fixture) => {
    if (fixture.gold.includes(ABSTAIN)) {
      return { ...fixture, goldIds: [], goldKinds: [], expectAbstain: true };
    }

    const goldIds: string[] = [];
    const goldKinds: CatalogKind[] = [];

    for (const token of fixture.gold) {
      // An explicit id is unambiguous, so it is used on its own. Otherwise the exact-name and
      // convention-normalised lookups are **unioned**, not tried in order: a token such as
      // `ak-debug` matches the pi copy by exact name while the claude copy is only reachable
      // through normalisation, and both are the same capability.
      const byIdMatch = index.byId.get(token);
      let matches: CatalogEntry[];

      if (byIdMatch !== undefined) {
        matches = [byIdMatch];
      } else {
        const exact = index.byName.get(token) ?? [];
        const normalised = index.byNormalisedName.get(normaliseGoldName(token)) ?? [];
        const seen = new Set<string>();
        matches = [];
        for (const candidate of [...exact, ...normalised]) {
          if (seen.has(candidate.id)) continue;
          seen.add(candidate.id);
          matches.push(candidate);
        }
      }

      if (matches.length === 0) {
        throw new FixtureError(
          `fixture "${fixture.id}": gold "${token}" is not in the eval corpus. ` +
            "Either the capability is not installed or the corpus snapshot needs refreshing.",
        );
      }
      for (const match of matches) {
        if (!goldIds.includes(match.id)) {
          goldIds.push(match.id);
          goldKinds.push(match.kind);
        }
      }
    }

    return { ...fixture, goldIds, goldKinds, expectAbstain: false };
  });
}

/** Count fixtures per group, for report headers. */
export function groupCounts(fixtures: readonly Fixture[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const fixture of fixtures) {
    counts[fixture.group] = (counts[fixture.group] ?? 0) + 1;
  }
  return counts;
}
