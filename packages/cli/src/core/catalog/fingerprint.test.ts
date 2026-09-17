import { describe, expect, it } from "vitest";
import { catalogFingerprint } from "./fingerprint.js";
import type { CatalogEntry } from "./types.js";

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "claude-code:skill:global:demo",
    kind: "skill",
    name: "demo",
    description: "does a thing",
    runtime: "claude-code",
    scope: "global",
    sourcePath: "/home/u/.claude/skills/demo/SKILL.md",
    ...overrides,
  };
}

describe("catalogFingerprint", () => {
  it("is stable across ordering", () => {
    const a = [entry({ name: "alpha" }), entry({ name: "beta", id: "x" })];
    const b = [entry({ name: "beta", id: "x" }), entry({ name: "alpha" })];

    expect(catalogFingerprint(a)).toBe(catalogFingerprint(b));
  });

  it("changes when an entry is added or removed", () => {
    const before = [entry({ name: "alpha" })];
    const after = [entry({ name: "alpha" }), entry({ name: "beta", id: "x" })];
    expect(catalogFingerprint(before)).not.toBe(catalogFingerprint(after));
  });

  it("changes when a description changes", () => {
    const before = [entry({ description: "old" })];
    const after = [entry({ description: "new" })];
    expect(catalogFingerprint(before)).not.toBe(catalogFingerprint(after));
  });

  it("ignores the source path so relocation does not invalidate caches", () => {
    const before = [entry({ sourcePath: "/home/u/.claude/skills/demo/SKILL.md" })];
    const after = [entry({ sourcePath: "/elsewhere/skills/demo/SKILL.md" })];
    expect(catalogFingerprint(before)).toBe(catalogFingerprint(after));
  });

  it("formats the digest with a sha256 prefix", () => {
    expect(catalogFingerprint([entry()])).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("handles an empty catalog", () => {
    expect(catalogFingerprint([])).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
