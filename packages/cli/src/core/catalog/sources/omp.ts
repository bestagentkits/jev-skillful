import path from "node:path";
import {
  collectMarkdownItems,
  collectSkillFiles,
  describeMcpServer,
  readMcpJsonFile,
  readSkillParts,
} from "../collect.js";
import { buildEntry } from "../entries.js";
import { isDirectory } from "../fsx.js";
import {
  type CatalogEntry,
  type CatalogScope,
  type CatalogSource,
  type ScanContext,
  normaliseDescription,
} from "../types.js";

/**
 * Oh My Pi (`omp`) surfaces.
 *
 * Verified layout under `~/.omp/agent`: `skills/<name>/SKILL.md`,
 * `managed-skills/<name>/SKILL.md`, `agents/*.md`, `mcp.json`, and a `config.yml`.
 *
 * Home resolution follows the AgentKit adapter's documented precedence so the
 * catalog matches the runtime: `AGENTKIT_OMP_HOME`, then `OMP_HOME` or
 * `PI_CODING_AGENT_DIR`, then `~/.omp/agent`, then `~/.omp`.
 */
export const ompSource: CatalogSource = {
  runtime: "omp",
  async scan(ctx) {
    const entries: CatalogEntry[] = [];
    const globalRoot = await resolveGlobalRoot(ctx);

    if (globalRoot !== null) {
      for (const skillsRoot of [
        path.join(globalRoot, "skills"),
        path.join(globalRoot, "managed-skills"),
      ]) {
        for (const skill of await collectSkillFiles(skillsRoot, { maxDepth: 2 })) {
          entries.push(await skillEntry(skill.file, skill.dir, "global"));
        }
      }

      for (const agent of await collectMarkdownItems(path.join(globalRoot, "agents"))) {
        entries.push(
          buildEntry("omp", "agent", "global", {
            name: agent.name,
            description: normaliseDescription(agent.description),
            sourcePath: agent.file,
            ...(agent.degraded ? { degraded: true } : {}),
          }),
        );
      }

      for (const rule of await collectMarkdownItems(path.join(globalRoot, "rules"))) {
        entries.push(
          buildEntry("omp", "rule", "global", {
            name: rule.name,
            description: normaliseDescription(rule.description),
            sourcePath: rule.file,
            ...(rule.degraded ? { degraded: true } : {}),
          }),
        );
      }

      for (const server of await readMcpJsonFile(path.join(globalRoot, "mcp.json"))) {
        entries.push(mcpEntry(server, "global", path.join(globalRoot, "mcp.json")));
      }
    }

    if (ctx.projectDir !== null) {
      const projectRoot = path.join(ctx.projectDir, ".omp");
      for (const skill of await collectSkillFiles(path.join(projectRoot, "skills"), {
        maxDepth: 2,
      })) {
        entries.push(await skillEntry(skill.file, skill.dir, "project"));
      }
      for (const rule of await collectMarkdownItems(path.join(projectRoot, "rules"))) {
        entries.push(
          buildEntry("omp", "rule", "project", {
            name: rule.name,
            description: normaliseDescription(rule.description),
            sourcePath: rule.file,
            ...(rule.degraded ? { degraded: true } : {}),
          }),
        );
      }
      for (const server of await readMcpJsonFile(path.join(projectRoot, "mcp.json"))) {
        entries.push(mcpEntry(server, "project", path.join(projectRoot, "mcp.json")));
      }
    }

    return entries;
  },
};

async function resolveGlobalRoot(ctx: ScanContext): Promise<string | null> {
  const override = ctx.env.AGENTKIT_OMP_HOME;
  if (typeof override === "string" && override.trim() !== "") return path.resolve(override.trim());

  const homeVar = ctx.env.OMP_HOME ?? ctx.env.PI_CODING_AGENT_DIR;
  if (typeof homeVar === "string" && homeVar.trim() !== "") {
    return path.resolve(homeVar.trim());
  }

  const agentDir = path.join(ctx.homeDir, ".omp", "agent");
  if (await isDirectory(agentDir)) return agentDir;
  const plain = path.join(ctx.homeDir, ".omp");
  if (await isDirectory(plain)) return plain;
  return null;
}

async function skillEntry(
  file: string,
  dir: string,
  scope: CatalogScope,
): Promise<CatalogEntry> {
  const parts = await readSkillParts(file, dir);
  return buildEntry("omp", "skill", scope, {
    name: parts.name,
    description: normaliseDescription(parts.description),
    sourcePath: file,
    ...(parts.degraded ? { degraded: true } : {}),
  });
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
  return buildEntry("omp", "mcp", scope, {
    name: server.name,
    description: normaliseDescription(describeMcpServer(server)),
    sourcePath,
    meta,
  });
}
