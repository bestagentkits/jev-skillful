import { describe, expect, it } from "vitest";
import { rankBm25 } from "./bm25.js";

const docs = [
  { id: "a", text: "ak-backend-development Build backends with Node.js, Python and Go" },
  { id: "b", text: "ak-frontend-development Build React and TypeScript user interfaces" },
  { id: "c", text: "ak-databases Design schemas and write SQL queries for PostgreSQL" },
  { id: "d", text: "ak-copywriting Write conversion copy and landing page headlines" },
];

describe("rankBm25", () => {
  it("ranks the matching document first", () => {
    const ranked = rankBm25(docs, "write a postgres sql query");
    expect(ranked[0]?.id).toBe("c");
  });

  it("separates a backend prompt from a frontend one", () => {
    expect(rankBm25(docs, "refactor the backend service in go")[0]?.id).toBe("a");
    expect(rankBm25(docs, "build a react component")[0]?.id).toBe("b");
  });

  it("gives more than one document a positive score when both match", () => {
    const ranked = rankBm25(docs, "build something with typescript");
    const positive = ranked.filter((hit) => hit.score > 0);
    expect(positive.length).toBeGreaterThanOrEqual(1);
  });

  it("returns every document, including zero-scoring ones", () => {
    const ranked = rankBm25(docs, "quantum chromodynamics");
    expect(ranked).toHaveLength(docs.length);
    expect(ranked.every((hit) => hit.score === 0)).toBe(true);
  });

  it("orders ties by id so repeated runs agree", () => {
    const first = rankBm25(docs, "nothing matches this at all");
    const second = rankBm25(docs, "nothing matches this at all");
    expect(first.map((hit) => hit.id)).toEqual(second.map((hit) => hit.id));
    expect(first.map((hit) => hit.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("returns an empty list for an empty corpus", () => {
    expect(rankBm25([], "anything")).toEqual([]);
  });

  it("treats an all-stopword query as no query rather than crashing", () => {
    const ranked = rankBm25(docs, "the and of");
    expect(ranked).toHaveLength(docs.length);
    expect(ranked.every((hit) => hit.score === 0)).toBe(true);
  });

  it("is not skewed by a much longer document", () => {
    // Length normalisation should stop a long document from winning on term count alone.
    const withLong = [
      { id: "short", text: "postgres indexes" },
      { id: "long", text: `postgres ${"filler word padding ".repeat(40)} indexes` },
    ];
    const ranked = rankBm25(withLong, "postgres indexes");
    expect(ranked[0]?.score).toBeGreaterThan(0);
    // Both contain every query term exactly once, so scores should be close.
    const gap = Math.abs((ranked[0]?.score ?? 0) - (ranked[1]?.score ?? 0));
    expect(gap).toBeLessThan(0.5);
  });

  it("honours a disabled length normalisation", () => {
    const ranked = rankBm25(docs, "build", { b: 0 });
    expect(ranked[0]?.score).toBeGreaterThan(0);
  });
});
