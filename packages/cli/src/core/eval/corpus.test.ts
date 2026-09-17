import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "../catalog/types.js";
import {
  collapseHomePrefix,
  hasInfrastructureIdentifier,
  isPublicSafe,
  redactInfrastructure,
  sanitiseCorpus,
} from "./corpus.js";

function entry(name: string, description = ""): CatalogEntry {
  return {
    id: `pi:skill:global:${name}`,
    kind: "skill",
    name,
    description,
    runtime: "pi",
    scope: "global",
    sourcePath: "/tmp",
  };
}

describe("isPublicSafe", () => {
  it("keeps an ordinary public capability", () => {
    expect(isPublicSafe(entry("ak-backend-development", "Build backends with Node.js"))).toBe(true);
  });

  it("withholds a capability naming a private project", () => {
    expect(isPublicSafe(entry("dewee-prod-postgres-k8s-cutover"))).toBe(false);
    expect(isPublicSafe(entry("zuey-vps-staging"))).toBe(false);
    expect(isPublicSafe(entry("cloud-harness-deploy-incident"))).toBe(false);
  });

  it("withholds a public-looking capability whose description names a private project", () => {
    // The name alone would pass; the description is what leaks.
    expect(isPublicSafe(entry("journal-writer", "Write journals about the zuey rollout"))).toBe(false);
  });

  it("does not delete the public orchestration skill when filtering for orca", () => {
    // `orca` is a substring of `orchestration`. Without a word boundary the sanitiser
    // silently removes a legitimate public capability.
    expect(isPublicSafe(entry("orchestration", "Coordinate agents across worktrees"))).toBe(true);
    expect(isPublicSafe(entry("orca-per-workspace-env", "Per-workspace environment recipes"))).toBe(false);
  });

  it("matches markers case-insensitively", () => {
    expect(isPublicSafe(entry("DeWeE-Ccp-Runtime"))).toBe(false);
  });

  it("keeps capabilities that the AgentKit public set uses", () => {
    for (const name of ["ak-debug", "ak-plan", "ak-git", "ak-security", "typesafe-ai"]) {
      expect(isPublicSafe(entry(name, "A public capability"))).toBe(true);
    }
  });
});

describe("sanitiseCorpus", () => {
  it("reports how many entries were withheld without naming them", () => {
    const result = sanitiseCorpus([
      entry("ak-debug"),
      entry("dewee-runtime-verification"),
      entry("zuey-ws"),
    ]);

    expect(result.kept).toHaveLength(1);
    expect(result.excludedCount).toBe(2);
  });

  it("returns everything when nothing matches", () => {
    const result = sanitiseCorpus([entry("ak-debug"), entry("ak-test")]);
    expect(result.kept).toHaveLength(2);
    expect(result.excludedCount).toBe(0);
    expect(result.redactedCount).toBe(0);
  });

  it("redacts a tenant URL rather than dropping an otherwise useful distractor", () => {
    // This is the shape that leaked: an innocuous entry name with a staging tenant and
    // account identifier inside the description.
    const leaky = entry("agent-brain", "MCP server (http): https://agent-brain-mcp-staging.acme.workers.dev/mcp");
    const result = sanitiseCorpus([leaky]);

    expect(result.kept).toHaveLength(1);
    expect(result.redactedCount).toBe(1);
    expect(result.kept[0]?.description).not.toContain("workers.dev");
    expect(result.kept[0]?.description).not.toContain("staging");
    expect(result.kept[0]?.description).toBe("MCP server (http): [redacted]");
  });

  it("redacts a filesystem path in a description", () => {
    const result = sanitiseCorpus([entry("computer-use", "MCP server (stdio): /Users/someone/Apps/Client")]);
    expect(result.kept[0]?.description).not.toContain("/Users/");
    expect(result.kept[0]?.description).toBe("MCP server (stdio): [redacted]");
  });

  it("redacts an MCP command whose path contains spaces", () => {
    // A path-based regex kept losing to this: the bundle name has spaces in it, so the
    // path pattern stopped at the first space and left the application name behind.
    const result = sanitiseCorpus([
      entry("computer-use", "MCP server (stdio): ./Codex Computer Use.app/Contents/MacOS/Client"),
    ]);

    expect(result.kept[0]?.description).not.toContain("Codex");
    expect(result.kept[0]?.description).toBe("MCP server (stdio): [redacted]");
  });

  it("collapses the home prefix in sourcePath but keeps the runtime layout", () => {
    const withPath: CatalogEntry = {
      ...entry("ak-debug"),
      sourcePath: "/Users/someone/.claude/skills/ak-debug/SKILL.md",
    };
    const result = sanitiseCorpus([withPath]);

    // The username is identity information; the layout after it is publicly known and
    // tells a reader which runtime root an entry came from.
    expect(result.kept[0]?.sourcePath).toBe("~/.claude/skills/ak-debug/SKILL.md");
    expect(result.kept[0]?.sourcePath).not.toContain("someone");
  });

  it("drops meta, which is where a service URL or a local command path lives", () => {
    const withMeta: CatalogEntry = {
      ...entry("agent-brain"),
      meta: { type: "http", url: "https://private-tenant.acme.workers.dev/mcp" },
    };
    const result = sanitiseCorpus([withMeta]);

    expect(result.kept[0]?.meta).toBeUndefined();
    expect(JSON.stringify(result.kept[0])).not.toContain("workers.dev");
  });

  it("counts an entry as redacted when any field changed", () => {
    const result = sanitiseCorpus([
      { ...entry("a"), sourcePath: "/Users/x/.config/a" },
      entry("b", "clean description here"),
    ]);
    expect(result.redactedCount).toBe(1);
    expect(result.kept).toHaveLength(2);
  });

  it("leaves a description with no identifier untouched", () => {
    const clean = entry("ak-debug", "Find the root cause of a failure before fixing it");
    const result = sanitiseCorpus([clean]);
    expect(result.kept[0]?.description).toBe(clean.description);
    expect(result.redactedCount).toBe(0);
  });
});

describe("redactInfrastructure", () => {
  it("replaces an http URL in ordinary prose, consuming the rest of the line", () => {
    // Documented trade-off. Allowing spaces in the path and URL patterns means a URL that is
    // followed by more prose on the same line takes that prose with it. Over-redacting is the
    // safe direction for a filter whose job is to remove infrastructure identifiers, and
    // catalog descriptions are single short lines.
    expect(redactInfrastructure("see https://internal.example.com/docs now")).toBe("see [url]");
  });

  it("replaces an absolute path with spaces in it", () => {
    expect(redactInfrastructure("run /Applications/My App.app/Contents/bin")).toBe("run [path]");
  });

  it("replaces an absolute home path", () => {
    expect(redactInfrastructure("run /Users/duy/apps/tool")).toBe("run [path]");
  });

  it("replaces a tilde path", () => {
    expect(redactInfrastructure("config at ~/.config/thing")).toBe("config at [path]");
  });

  it("handles several identifiers in one string", () => {
    const output = redactInfrastructure("a https://x.test/b b ~/c d /Users/e/f");
    expect(output).not.toContain("https://");
    expect(output).not.toContain("~/");
    expect(output).not.toContain("/Users/");
  });
});

describe("collapseHomePrefix", () => {
  it("collapses a macOS home path", () => {
    expect(collapseHomePrefix("/Users/duy/.codex/config.toml")).toBe("~/.codex/config.toml");
  });

  it("collapses a Linux home path", () => {
    expect(collapseHomePrefix("/home/duy/.config/a.json")).toBe("~/.config/a.json");
  });

  it("leaves a path outside a home directory alone", () => {
    expect(collapseHomePrefix("/opt/tools/x")).toBe("/opt/tools/x");
  });
});

describe("hasInfrastructureIdentifier", () => {
  it("detects each identifier kind", () => {
    expect(hasInfrastructureIdentifier("https://x.test")).toBe(true);
    expect(hasInfrastructureIdentifier("/Users/x/y")).toBe(true);
    expect(hasInfrastructureIdentifier("~/x")).toBe(true);
  });

  it("does not fire on ordinary prose", () => {
    expect(hasInfrastructureIdentifier("Build backends with Node.js and Go")).toBe(false);
  });
});
