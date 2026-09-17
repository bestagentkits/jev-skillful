import path from "node:path";
import {
  collectSkillFiles,
  describeMcpServer,
  readSkillParts,
  readTomlTopLevelStrings,
} from "../collect.js";
import { buildEntry } from "../entries.js";
import { filesWithExtension, readTextSafe } from "../fsx.js";
import {
  type CatalogEntry,
  type CatalogScope,
  type CatalogSource,
  type ScanContext,
  normaliseDescription,
} from "../types.js";
import { parseMcpServersFromToml } from "../toml.js";

/**
 * Codex surfaces.
 *
 * Verified layout:
 * - Skills are shared with other `agents`-convention clients, so they live under
 *   `~/.agents/skills/<name>/SKILL.md` (overridable with
 *   `AGENTKIT_CODEX_SKILLS_ROOT`), not under `~/.codex`.
 * - `~/.codex/config.toml` holds `[mcp_servers.<name>]` tables.
 * - `~/.codex/agents/<name>.toml` holds role files with top-level `name` and
 *   `developer_instructions`.
 *
 * The `~/.codex/hooks.json` file exists but describes hooks, not capabilities, so
 * it is not part of the catalog.
 */

const SKILLS_ROOT_ENV = "AGENTKIT_CODEX_SKILLS_ROOT";

export const codexSource: CatalogSource = {
  runtime: "codex",
  async scan(ctx) {
    const entries: CatalogEntry[] = [];

    for (const [root, scope] of skillRoots(ctx)) {
      for (const skill of await collectSkillFiles(root, { maxDepth: 2 })) {
        const entry = await readSkillEntry(skill.file, skill.dir, scope);
        entries.push(entry);
      }
    }

    for (const [base, scope] of [
      [path.join(ctx.homeDir, ".codex"), "global"],
      [ctx.projectDir === null ? null : path.join(ctx.projectDir, ".codex"), "project"],
    ] as const) {
      if (base === null) continue;
      await scanConfigDir(base, scope, entries);
    }

    return entries;
  },
};

/** Skill roots, honouring the AgentKit override that pins every scope together. */
function skillRoots(ctx: ScanContext): Array<[string, CatalogScope]> {
  const override = ctx.env[SKILLS_ROOT_ENV];
  if (typeof override === "string" && override.trim() !== "") {
    // The override collapses global and project into one directory; report it once
    // as global so the duplicate is not counted twice.
    return [[path.resolve(override.trim()), "global"]];
  }
  const roots: Array<[string, CatalogScope]> = [[path.join(ctx.homeDir, ".agents", "skills"), "global"]];
  if (ctx.projectDir !== null) {
    roots.push([path.join(ctx.projectDir, ".agents", "skills"), "project"]);
  }
  return roots;
}

async function scanConfigDir(
  base: string,
  scope: CatalogScope,
  entries: CatalogEntry[],
): Promise<void> {
  const configPath = path.join(base, "config.toml");
  const configText = await readTextSafe(configPath);
  if (configText !== null) {
    for (const server of parseMcpServersFromToml(configText)) {
      const meta: Record<string, string> = {};
      if (server.command !== undefined) meta.command = server.command;
      if (server.args !== undefined) meta.args = server.args.join(" ");
      if (server.url !== undefined) meta.url = server.url;
      entries.push(
        buildEntry("codex", "mcp", scope, {
          name: server.name,
          description: normaliseDescription(describeMcpServer(server)),
          sourcePath: configPath,
          meta,
        }),
      );
    }
  }

  const agentsDir = path.join(base, "agents");
  for (const file of await filesWithExtension(agentsDir, [".toml"])) {
    const text = await readTextSafe(file);
    const stem = path.basename(file).replace(/\.toml$/i, "");
    if (text === null) {
      entries.push(
        buildEntry("codex", "agent", scope, {
          name: stem,
          description: "",
          sourcePath: file,
          degraded: true,
        }),
      );
      continue;
    }
    const fields = readTomlTopLevelStrings(text, ["name", "description", "developer_instructions"]);
    const name = fields.name ?? stem;
    const raw = fields.description ?? fields.developer_instructions ?? "";
    entries.push(
      buildEntry("codex", "agent", scope, {
        name,
        description: normaliseDescription(raw),
        sourcePath: file,
        degraded: raw === "",
      }),
    );
  }
}

async function readSkillEntry(
  file: string,
  dir: string,
  scope: CatalogScope,
): Promise<CatalogEntry> {
  const parts = await readSkillParts(file, dir);
  return buildEntry("codex", "skill", scope, {
    name: parts.name,
    description: normaliseDescription(parts.description),
    sourcePath: file,
    ...(parts.degraded ? { degraded: true } : {}),
  });
}
