import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./frontmatter.js";

describe("parseFrontmatter", () => {
  it("reads name and description from a normal block", () => {
    const text = [
      "---",
      "name: ak-brainstorm",
      "description: Turn unclear intent into a bounded delivery contract.",
      "---",
      "",
      "# Body",
    ].join("\n");

    expect(parseFrontmatter(text)).toEqual({
      name: "ak-brainstorm",
      description: "Turn unclear intent into a bounded delivery contract.",
      degraded: false,
    });
  });

  it("strips quotes and keeps namespaced names intact", () => {
    const text = ['---', 'name: "ak:advise"', "description: 'quoted'", "---"].join("\n");

    expect(parseFrontmatter(text)).toEqual({
      name: "ak:advise",
      description: "quoted",
      degraded: false,
    });
  });

  it("folds block scalars", () => {
    const text = [
      "---",
      "name: multi",
      "description: >",
      "  first line",
      "  second line",
      "---",
    ].join("\n");

    expect(parseFrontmatter(text).description).toBe("first line second line");
  });

  it("ignores unknown keys and comments", () => {
    const text = [
      "---",
      "# a comment",
      "user-invocable: true",
      "name: only-name",
      "when_to_use: something else",
      "---",
    ].join("\n");

    const parsed = parseFrontmatter(text);
    expect(parsed.name).toBe("only-name");
    // No description key at all, which the caller must treat as degraded.
    expect(parsed.description).toBeUndefined();
    expect(parsed.degraded).toBe(false);
  });

  it("marks a document with no frontmatter as degraded", () => {
    expect(parseFrontmatter("# Just a heading\n")).toEqual({ degraded: true });
  });

  it("marks an unterminated block as degraded", () => {
    expect(parseFrontmatter("---\nname: broken\n").degraded).toBe(true);
  });

  it("marks a block without a name as degraded", () => {
    expect(parseFrontmatter("---\ndescription: no name here\n---").degraded).toBe(true);
  });

  it("tolerates a UTF-8 BOM and CRLF line endings", () => {
    const text = "\uFEFF---\r\nname: bom\r\ndescription: crlf\r\n---\r\n";
    expect(parseFrontmatter(text)).toEqual({
      name: "bom",
      description: "crlf",
      degraded: false,
    });
  });

  it("accepts ... as a closing delimiter", () => {
    expect(parseFrontmatter("---\nname: dotted\n...").name).toBe("dotted");
  });
});
