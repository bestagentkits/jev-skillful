import path from "node:path";
import {
  collectMarkdownItems,
  collectSkillFiles,
  describeMcpServer,
  readMcpJsonFile,
  readSkillParts,
} from "../collect.js";
import { buildEntry } from "../entries.js";
import {
  type CatalogEntry,
  type CatalogScope,
  type CatalogSource,
  type ScanContext,
  normaliseDescription,
} from "../types.js";

/**
 * Pi surfaces.
 *
 * Verified layout under `~/.pi/agent`: `skills/<name>/SKILL.md`, `agents/*.md`,
 * `rules/*.md`.
 *
 * MCP is the interesting one. Pi has no MCP file of its own; the `pi-mcp-adapter`
 * package reads a shared set of locations, so those are what we scan. Read
 * directly from the adapter's `config.ts` rather than guessed:
 * - `~/.pi/agent/mcp.json` (agent-dir config)
 * - `~/.agents/mcp.json` and `~/.agents/mcp/mcp.json` (shared agent convention)
 * - `~/.config/mcp/mcp.json` (generic convention)
 * - project `.pi/mcp.json` and `.mcp.json` (shared cross-client convention)
 */

const GLOBAL_MCP_FILES = (homeDir: string): string[] => [
  path.join(homeDir, ".pi", "agent", "mcp.json"),
  path.join(homeDir, ".agents", "mcp.json"),
  path.join(homeDir, ".agents", "mcp", "mcp.json"),
  path.join(homeDir, ".config", "mcp", "mcp.json"),
];

export const piSource: CatalogSource = {
  runtime: "pi",
  async scan(ctx) {
    const entries: CatalogEntry[] = [];
    const globalRoot = path.join(ctx.homeDir, ".pi", "agent");

    for (const [root, scope] of [
      [globalRoot, "global"],
      [ctx.projectDir === null ? null : path.join(ctx.projectDir, ".pi"), "project"],
    ] as const) {
      if (root === null) continue;
      await scanTree(root, scope, entries);
    }

    await scanMcp(ctx, entries);
    return entries;
  },
};

async function scanTree(
  root: string,
  scope: CatalogScope,
  entries: CatalogEntry[],
): Promise<void> {
  for (const skill of await collectSkillFiles(path.join(root, "skills"), { maxDepth: 2 })) {
    const parts = await readSkillParts(skill.file, skill.dir);
    entries.push(
      buildEntry("pi", "skill", scope, {
        name: parts.name,
        description: normaliseDescription(parts.description),
        sourcePath: skill.file,
        ...(parts.degraded ? { degraded: true } : {}),
      }),
    );
  }

  for (const agent of await collectMarkdownItems(path.join(root, "agents"))) {
    entries.push(
      buildEntry("pi", "agent", scope, {
        name: agent.name,
        description: normaliseDescription(agent.description),
        sourcePath: agent.file,
        ...(agent.degraded ? { degraded: true } : {}),
      }),
    );
  }

  for (const rule of await collectMarkdownItems(path.join(root, "rules"))) {
    entries.push(
      buildEntry("pi", "rule", scope, {
        name: rule.name,
        description: normaliseDescription(rule.description),
        sourcePath: rule.file,
        ...(rule.degraded ? { degraded: true } : {}),
      }),
    );
  }
}

async function scanMcp(ctx: ScanContext, entries: CatalogEntry[]): Promise<void> {
  for (const file of GLOBAL_MCP_FILES(ctx.homeDir)) {
    for (const server of await readMcpJsonFile(file)) {
      entries.push(mcpEntry(server, "global", file));
    }
  }
  if (ctx.projectDir === null) return;

  for (const file of [
    path.join(ctx.projectDir, ".pi", "mcp.json"),
    path.join(ctx.projectDir, ".mcp.json"),
  ]) {
    for (const server of await readMcpJsonFile(file)) {
      entries.push(mcpEntry(server, "project", file));
    }
  }
}

function mcpEntry(
  server: { name: string; url?: string; command?: string; type?: string; args?: string[] },
  scope: CatalogScope,
  sourcePath: string,
): CatalogEntry {
  const meta: Record<string, string> = {};
  if (server.type !== undefined) meta.type = server.type;
  if (server.url !== undefined) meta.url = server.url;
  if (server.command !== undefined) meta.command = server.command;
  return buildEntry("pi", "mcp", scope, {
    name: server.name,
    description: normaliseDescription(describeMcpServer(server)),
    sourcePath,
    meta,
  });
}
