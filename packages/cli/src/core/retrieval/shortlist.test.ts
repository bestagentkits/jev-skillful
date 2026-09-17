import { describe, expect, it } from "vitest";
import type { CatalogEntry, CatalogKind } from "../catalog/types.js";
import { DEFAULT_QUOTA_GROUPS, buildShortlist } from "./shortlist.js";

let counter = 0;

function entry(name: string, kind: CatalogKind, description: string): CatalogEntry {
  counter += 1;
  return {
    id: `test:${kind}:global:${name}`,
    kind,
    name,
    description,
    runtime: "pi",
    scope: "global",
    sourcePath: `/tmp/${kind}/${name}`,
  };
}

/** A copy of `name` installed under a different runtime, with the same description. */
function copyFor(
  source: CatalogEntry,
  runtime: CatalogEntry["runtime"],
  name: string,
): CatalogEntry {
  return { ...source, id: `${runtime}:${source.kind}:global:${name}`, name, runtime, sourcePath: `/tmp/${runtime}/${name}` };
}

/** `count` entries of one kind, each with a distinct description. */
function many(
  kind: CatalogKind,
  count: number,
  description: (index: number) => string,
): CatalogEntry[] {
  return Array.from({ length: count }, (_, i) => entry(`${kind}-${i}`, kind, description(i)));
}

/**
 * Note on fixtures: two entries of the same kind with a byte-identical description are
 * collapsed into one candidate by design, because the model cannot tell them apart. Every
 * fixture below therefore gives each entry its own description, which is also what real
 * installed capabilities look like.
 */
describe("buildShortlist", () => {
  it("cuts each kind group to its own quota", () => {
    const entries = [
      ...many("skill", 20, (i) => `write backend service number ${i}`),
      ...many("mcp", 10, (i) => `connect to datastore number ${i}`),
      ...many("agent", 5, (i) => `delegate review task number ${i}`),
    ];

    const shortlist = buildShortlist(entries, "write backend code");

    expect(shortlist.entries.filter((e) => e.kind === "skill")).toHaveLength(6);
    expect(shortlist.entries.filter((e) => e.kind === "mcp")).toHaveLength(4);
    expect(shortlist.entries.filter((e) => e.kind === "agent")).toHaveLength(3);
    expect(shortlist.entries).toHaveLength(13);
  });

  it("sends K=15 candidates when every group is full", () => {
    const entries = [
      ...many("skill", 20, (i) => `write backend service number ${i}`),
      ...many("mcp", 10, (i) => `connect to datastore number ${i}`),
      ...many("agent", 10, (i) => `delegate review task number ${i}`),
      ...many("command", 10, (i) => `run task number ${i}`),
      ...many("rule", 10, (i) => `enforce convention number ${i}`),
    ];

    expect(buildShortlist(entries, "write backend code").entries).toHaveLength(15);
  });

  it("does not redistribute unused quota to other kinds", () => {
    // Only skills exist, so the shortlist is 6 rather than a group of 15 skills.
    const entries = many("skill", 40, (i) => `write backend service number ${i}`);
    const shortlist = buildShortlist(entries, "backend code");

    expect(shortlist.entries).toHaveLength(6);
    expect(shortlist.entries.every((e) => e.kind === "skill")).toBe(true);
  });

  it("shares one quota between command and rule", () => {
    const entries = [
      ...many("command", 10, (i) => `run task number ${i}`),
      ...many("rule", 10, (i) => `enforce convention number ${i}`),
    ];
    const shortlist = buildShortlist(entries, "run tests");

    expect(shortlist.entries).toHaveLength(2);
  });

  it("reports truncation per group", () => {
    const entries = many("skill", 40, (i) => `write backend service number ${i}`);
    const shortlist = buildShortlist(entries, "backend code");
    const skillGroup = shortlist.groups.find((group) => group.kinds.includes("skill"));

    expect(skillGroup?.truncated).toBe(true);
    expect(skillGroup?.selected).toBe(6);
  });

  it("returns an empty shortlist for an empty catalog", () => {
    const shortlist = buildShortlist([], "do something");
    expect(shortlist.entries).toEqual([]);
    expect(shortlist.groups).toHaveLength(DEFAULT_QUOTA_GROUPS.length);
  });

  it("accepts a custom quota set", () => {
    const entries = many("skill", 40, (i) => `write backend service number ${i}`);
    const shortlist = buildShortlist(entries, "backend code", [{ kinds: ["skill"], limit: 2 }]);
    expect(shortlist.entries).toHaveLength(2);
  });

  it("prefers the better BM25 match within a group", () => {
    const entries = [
      entry("irrelevant", "skill", "unrelated content about gardening"),
      entry("target", "skill", "refactor authentication middleware with refresh tokens"),
    ];
    const shortlist = buildShortlist(entries, "refactor authentication middleware");
    expect(shortlist.entries[0]?.id).toBe("test:skill:global:target");
  });
});

describe("buildShortlist — indistinguishable copies", () => {
  const DESCRIPTION = "Build backends with Node.js, Python and Go. REST APIs and auth.";

  it("offers a capability installed under two roots only once", () => {
    const claudeCopy = copyFor(entry("ak-backend-development", "skill", DESCRIPTION), "claude-code", "ak:backend-development");
    const agentsCopy = copyFor(entry("ak-backend-development", "skill", DESCRIPTION), "pi", "ak-backend-development");

    const shortlist = buildShortlist([claudeCopy, agentsCopy], "backend APIs with auth");

    expect(shortlist.entries).toHaveLength(1);
  });

  it("records the other root as an alternate path on the survivor", () => {
    const claudeCopy = copyFor(entry("ak-backend-development", "skill", DESCRIPTION), "claude-code", "ak:backend-development");
    const agentsCopy = copyFor(entry("ak-backend-development", "skill", DESCRIPTION), "pi", "ak-backend-development");

    const shortlist = buildShortlist([claudeCopy, agentsCopy], "backend APIs with auth");
    const survivor = shortlist.entries[0];

    expect(survivor).toBeDefined();
    if (survivor === undefined) throw new Error("expected one survivor");

    expect(survivor.alternates).toHaveLength(1);
    // The survivor and its alternate must point at different files. That difference is
    // exactly what makes the alternate useful to a hook running inside the other runtime.
    const alternatePath = survivor.alternates[0]?.sourcePath;
    expect(alternatePath).toContain("ak-backend-development");
    expect(alternatePath).not.toBe(survivor.entry.sourcePath);
  });

  it("counts a freed slot and fills it with a different capability", () => {
    const claudeCopy = copyFor(entry("ak-backend-development", "skill", DESCRIPTION), "claude-code", "ak:backend-development");
    const agentsCopy = copyFor(entry("ak-backend-development", "skill", DESCRIPTION), "pi", "ak-backend-development");
    const other = entry("ak-databases", "skill", "Design schemas and write backend SQL queries.");

    const shortlist = buildShortlist([claudeCopy, agentsCopy, other], "backend SQL and auth", [
      { kinds: ["skill"], limit: 2 },
    ]);

    // Two distinct capabilities fill the two slots, instead of one slot wasted on a copy.
    expect(shortlist.entries).toHaveLength(2);
    expect(new Set(shortlist.entries.map((item) => item.id)).size).toBe(2);
  });

  it("reports how many duplicates it removed", () => {
    const claudeCopy = copyFor(entry("ak-backend-development", "skill", DESCRIPTION), "claude-code", "ak:backend-development");
    const agentsCopy = copyFor(entry("ak-backend-development", "skill", DESCRIPTION), "pi", "ak-backend-development");

    const shortlist = buildShortlist([claudeCopy, agentsCopy], "backend auth");
    const skillGroup = shortlist.groups.find((group) => group.kinds.includes("skill"));

    expect(skillGroup?.duplicatesRemoved).toBe(1);
  });

  it("does not collapse a skill and an MCP server that share a description", () => {
    const skill = copyFor(entry("shared", "skill", DESCRIPTION), "pi", "shared");
    const mcp = copyFor(entry("shared", "mcp", DESCRIPTION), "pi", "shared");

    const shortlist = buildShortlist([skill, mcp], "backend APIs with auth");

    // Same words, different kind: these are different things and both stay.
    expect(shortlist.entries).toHaveLength(2);
  });

  it("does not collapse two different capabilities with different descriptions", () => {
    const a = entry("ak-backend-development", "skill", DESCRIPTION);
    const b = entry("ak-frontend-development", "skill", "Build React and TypeScript user interfaces.");

    const shortlist = buildShortlist([a, b], "build something");
    expect(shortlist.entries).toHaveLength(2);
    expect(shortlist.entries.every((item) => item.alternates.length === 0)).toBe(true);
  });
});
