import { describe, expect, it } from "vitest";
import { tokenize } from "./tokenize.js";

describe("tokenize", () => {
  it("splits kebab-case capability ids into separate terms", () => {
    expect(tokenize("ak-backend-development")).toEqual(["ak", "backend", "development"]);
  });

  it("splits camelCase into separate terms", () => {
    expect(tokenize("claudeFable")).toEqual(["claude", "fable"]);
  });

  it("splits an acronym followed by a word", () => {
    expect(tokenize("HTTPServer")).toEqual(["http", "server"]);
  });

  it("splits snake_case into separate terms", () => {
    expect(tokenize("postgres_mcp_server")).toEqual(["postgres", "mcp", "server"]);
  });

  it("drops a trailing file extension so SKILL.md is just skill", () => {
    expect(tokenize("SKILL.md")).toEqual(["skill"]);
  });

  it("lowercases everything", () => {
    expect(tokenize("REFACTOR the Auth Middleware")).toEqual(["refactor", "auth", "middleware"]);
  });

  it("splits a trailing acronym from the word in front of it", () => {
    expect(tokenize("FastAPI")).toEqual(["fast", "api"]);
    expect(tokenize("GraphQL")).toEqual(["graph", "ql"]);
    expect(tokenize("OpenGL")).toEqual(["open", "gl"]);
  });

  it("splits a leading acronym from the word behind it", () => {
    expect(tokenize("JWTToken")).toEqual(["jwt", "token"]);
  });

  it("over-splits a word with capitals in the middle", () => {
    // A documented limitation rather than a promise. `SeQUential` is not a real
    // identifier shape, and the acronym rule reads the inner capitals as a boundary.
    // Real mixed-case names such as GraphQL and FastAPI tokenise correctly above, and
    // every catalog name measured so far falls into that group.
    expect(tokenize("SeQUential")).toEqual(["se", "q", "uential"]);
  });

  it("removes stopwords but keeps verbs that carry task signal", () => {
    expect(tokenize("fix the typo in the readme")).toEqual(["fix", "typo", "readme"]);
  });

  it("keeps words a general stopword list would wrongly drop", () => {
    // `use`, `add`, `create` and `write` decide what a capability is for.
    expect(tokenize("use this to add a create write flow")).toEqual([
      "use",
      "add",
      "create",
      "write",
      "flow",
    ]);
  });

  it("tokenises accented Vietnamese text without special handling", () => {
    expect(tokenize("tối ưu hoá truy vấn")).toEqual(["tối", "ưu", "hoá", "truy", "vấn"]);
  });

  it("handles a realistic description", () => {
    const tokens = tokenize("Build backends with Node.js, Python, Go (NestJS, FastAPI, Django).");
    expect(tokens).toContain("backends");
    // FastAPI splits on its acronym boundary, which is symmetric: a prompt mentioning
    // FastAPI tokenises the same way, so the two still match.
    expect(tokens).toContain("fast");
    expect(tokens).toContain("api");
    expect(tokens).toContain("django");
    expect(tokens).not.toContain("with");
  });

  it("returns nothing for empty input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
    expect(tokenize("!!! ???")).toEqual([]);
  });

  it("keeps two-character terms that are meaningful", () => {
    expect(tokenize("go rust ak")).toEqual(["go", "rust", "ak"]);
  });
});
