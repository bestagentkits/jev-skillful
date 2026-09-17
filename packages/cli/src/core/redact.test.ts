/**
 * Tests for redaction.
 *
 * These assert on the exact strings a real machine produces, because the failure this module
 * guards against is not abstract: it is a username, a home directory, or an API key appearing in
 * a public issue that a user opened in good faith.
 */

import { describe, expect, it } from "vitest";
import { redactText, redactValue, redactedEnvNames } from "./redact.js";

const HOME = "/Users/example";

describe("redactText", () => {
  it("collapses the home directory to ~ so a bug report stays useful", () => {
    expect(redactText(`${HOME}/.claude/skills/foo`, { homeDir: HOME })).toBe("~/.claude/skills/foo");
  });

  it("removes another user's home path entirely", () => {
    expect(redactText("/Users/someone-else/notes.md", { homeDir: HOME })).toBe("<home>/notes.md");
    expect(redactText("/home/other/file.md", { homeDir: HOME })).toBe("<home>/file.md");
  });

  it("removes absolute paths outside a home directory", () => {
    expect(redactText("/var/folders/ab/cd/T/tmp123/index.ts", { homeDir: HOME })).toBe("<path>");
    expect(redactText("/opt/homebrew/bin/node", { homeDir: HOME })).toBe("<path>");
  });

  it("redacts an API key by shape", () => {
    const key = "sk-abcdefghijklmnopqrstuvwxyz012345";
    expect(redactText(`Authorization: Bearer ${key}`, { homeDir: HOME })).not.toContain(key);
    expect(redactText("token ak_live_abcdefghijklmnop", { homeDir: HOME })).not.toContain("ak_live");
    expect(redactText("ghp_abcdefghijklmnopqrstuvwx", { homeDir: HOME })).toContain("<redacted>");
  });

  it("redacts a JWT", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(redactText(jwt, { homeDir: HOME })).toBe("<redacted>");
  });

  it("removes credentials embedded in a URL", () => {
    expect(redactText("https://user:hunter2@example.com/mcp", { homeDir: HOME })).toBe(
      "https://<redacted>@example.com/mcp",
    );
  });

  it("redacts the value of any environment variable whose name looks sensitive", () => {
    const env = {
      TYPESAFE_API_KEY: "super-secret-value-1234",
      CLOUDFLARE_API_TOKEN: "another-secret-5678",
      MY_PASSWORD: "hunter2hunter2",
      HOME: HOME,
      PATH: "/usr/bin:/bin",
    };

    const text = `key=${env.TYPESAFE_API_KEY} token=${env.CLOUDFLARE_API_TOKEN} pw=${env.MY_PASSWORD}`;
    const out = redactText(text, { homeDir: HOME, env });

    expect(out).not.toContain("super-secret-value-1234");
    expect(out).not.toContain("another-secret-5678");
    expect(out).not.toContain("hunter2hunter2");
    expect(out).toContain("<redacted-env>");
  });

  it("leaves a short or non-sensitive environment value alone", () => {
    const env = { LOG_LEVEL: "debug", HTTP_PROXY: "http://127.0.0.1:8080" };
    expect(redactText("level=debug", { homeDir: HOME, env })).toContain("debug");
  });

  it("redacts a configured base URL passed as a literal", () => {
    const out = redactText("endpoint https://internal.corp.example/v1 used", {
      homeDir: HOME,
      literals: ["https://internal.corp.example"],
    });
    expect(out).not.toContain("internal.corp.example");
  });

  it("redacts email addresses", () => {
    expect(redactText("contact me@example.com please", { homeDir: HOME })).toBe(
      "contact <email> please",
    );
  });

  it("prefers the specific env-value redaction over a shape rule that would otherwise catch it", () => {
    // A hex-looking secret would be caught by the generic shape rule, but the specific value
    // replacement must happen first so the marker is the accurate one.
    const env = { MY_SECRET_TOKEN: "0123456789abcdef0123456789abcdef01234567" };
    const out = redactText(`value ${env.MY_SECRET_TOKEN}`, { homeDir: HOME, env });
    expect(out).toContain("<redacted-env>");
    expect(out).not.toContain("0123456789abcdef");
  });
});

describe("redactValue", () => {
  it("redacts nested strings and leaves the structure intact", () => {
    const input = {
      decision: { kind: "injected", primary: { sourcePath: `${HOME}/.claude/skills/x/SKILL.md` } },
      shortlist: [`claude-code:skill:global:x`, `${HOME}/other`],
      latencyMs: 42,
      nested: { deep: { path: "/opt/homebrew/bin/node" } },
    };

    const out = redactValue(input, { homeDir: HOME });

    expect(out.decision.primary.sourcePath).toBe("~/.claude/skills/x/SKILL.md");
    expect(out.shortlist[1]).toBe("~/other");
    expect(out.nested.deep.path).toBe("<path>");
    // Non-string values survive untouched.
    expect(out.latencyMs).toBe(42);
    // The input is not mutated.
    expect(input.decision.primary.sourcePath).toBe(`${HOME}/.claude/skills/x/SKILL.md`);
  });
});

describe("redactedEnvNames", () => {
  it("lists the names it treated as sensitive, without their values", () => {
    const names = redactedEnvNames({
      env: {
        TYPESAFE_API_KEY: "aaaaaaaaaaaa",
        HOME: HOME,
        PATH: "/usr/bin",
      },
    });
    expect(names).toEqual(["TYPESAFE_API_KEY"]);
  });
});
