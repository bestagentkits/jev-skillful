import { describe, expect, it } from "vitest";
import { parseMcpServersFromToml } from "./toml.js";

describe("parseMcpServersFromToml", () => {
  it("reads every server table with a parent header present", () => {
    // This mirrors the real shape of ~/.codex/config.toml: a bare parent table
    // followed by per-server subtables.
    const text = [
      "[mcp_servers]",
      "",
      "[mcp_servers.agentbrain]",
      'type = "http"',
      'url = "https://mcp.ab.agentbrain.sh/mcp"',
      "",
      "[mcp_servers.node_repl]",
      'command = "/usr/local/bin/node_repl"',
      'args = ["--flag", "--other"]',
    ].join("\n");

    const servers = parseMcpServersFromToml(text);
    expect(servers).toHaveLength(2);
    expect(servers[0]).toEqual({
      name: "agentbrain",
      url: "https://mcp.ab.agentbrain.sh/mcp",
    });
    expect(servers[1]).toEqual({
      name: "node_repl",
      command: "/usr/local/bin/node_repl",
      args: ["--flag", "--other"],
    });
  });

  it("handles quoted server names", () => {
    const text = ['[mcp_servers."my server"]', 'command = "run"'].join("\n");
    expect(parseMcpServersFromToml(text)).toEqual([
      { name: "my server", command: "run" },
    ]);
  });

  it("ignores comment-only and unrelated tables", () => {
    const text = [
      "[features]",
      "hooks = true",
      "",
      "[mcp_servers.real]",
      'command = "x"  # trailing comment',
      "",
      "[other_section]",
      'command = "should-not-appear"',
    ].join("\n");

    const servers = parseMcpServersFromToml(text);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.name).toBe("real");
    expect(servers[0]?.command).toBe("x");
  });

  it("drops servers with no command or url", () => {
    const text = ["[mcp_servers.empty]", 'type = "http"'].join("\n");
    expect(parseMcpServersFromToml(text)).toEqual([]);
  });

  it("returns nothing for an empty or unrelated document", () => {
    expect(parseMcpServersFromToml("")).toEqual([]);
    expect(parseMcpServersFromToml("[features]\nhooks = true\n")).toEqual([]);
  });
});
