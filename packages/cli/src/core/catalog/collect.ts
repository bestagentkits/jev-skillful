import path from "node:path";
import {
  filesWithExtension,
  isFile,
  listDirSafe,
  readJsonSafe,
  readTextSafe,
  subdirectories,
} from "./fsx.js";
import { parseFrontmatter } from "./frontmatter.js";

/**
 * Shared collectors used by every runtime source.
 *
 * The supported runtimes store the same kinds of things in similar but not
 * identical layouts. These helpers absorb the common shapes so each source only
 * has to describe where its surfaces live.
 */

export interface SkillFile {
  /** Directory containing SKILL.md; its basename is the fallback name. */
  dir: string;
  file: string;
}

/**
 * Find every `<dir>/SKILL.md` under `root`, bounded by `maxDepth`.
 *
 * Skills are the only surface stored as a directory per item. Recursion is
 * depth-limited because plugin caches can nest deeply and a runaway walk would
 * cost more than the catalog is worth.
 */
export async function collectSkillFiles(
  root: string,
  options: { maxDepth?: number; limit?: number } = {},
): Promise<SkillFile[]> {
  const maxDepth = options.maxDepth ?? 3;
  const limit = options.limit ?? 1_000;
  const found: SkillFile[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (found.length >= limit || depth > maxDepth) return;
    const skillFile = path.join(dir, "SKILL.md");
    if (await isFile(skillFile)) {
      found.push({ dir, file: skillFile });
      return;
    }
    for (const child of await subdirectories(dir)) {
      if (found.length >= limit) return;
      await walk(child, depth + 1);
    }
  }

  await walk(root, 0);
  return found;
}

export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  type?: string;
}

interface RawMcpFile {
  mcpServers?: Record<string, unknown>;
}

/**
 * Read an MCP config file and return its declared servers.
 *
 * MCP declarations carry no human description, so the router only ever sees the
 * server name plus a synthesised transport summary. That is a real weakness for
 * retrieval and is documented as such.
 */
export async function readMcpJsonFile(file: string): Promise<McpServerConfig[]> {
  const parsed = await readJsonSafe<RawMcpFile>(file);
  if (parsed === null) return [];
  return serversFromRecord(parsed.mcpServers);
}

/** Normalise a `mcpServers` record into server configs. */
export function serversFromRecord(record: unknown): McpServerConfig[] {
  if (record === null || typeof record !== "object") return [];
  const out: McpServerConfig[] = [];
  for (const [name, value] of Object.entries(record as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") {
      out.push({ name });
      continue;
    }
    const config = value as Record<string, unknown>;
    const server: McpServerConfig = { name };
    if (typeof config.command === "string") server.command = config.command;
    if (typeof config.url === "string") server.url = config.url;
    if (typeof config.type === "string") server.type = config.type;
    if (Array.isArray(config.args)) {
      const args = config.args.filter((arg): arg is string => typeof arg === "string");
      if (args.length > 0) server.args = args;
    }
    out.push(server);
  }
  return out;
}

/** Build the description shown to the router for an MCP server. */
export function describeMcpServer(server: McpServerConfig): string {
  const target = server.url ?? server.command ?? "";
  const transport = server.type ?? (server.url !== undefined ? "http" : "stdio");
  if (target === "") return `MCP server (${transport})`;
  return `MCP server (${transport}): ${target}`;
}

/**
 * Read top-level string keys from a TOML document.
 *
 * Only used for Codex agent role files, which are small TOML documents with
 * `name` and `developer_instructions` at the top level.
 */
export function readTomlTopLevelStrings(text: string, keys: string[]): Record<string, string> {
  const wanted = new Set(keys);
  const out: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    // Stop caring about top-level keys once a table starts.
    if (line.startsWith("[") || line === "") continue;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    if (key === undefined || !wanted.has(key) || out[key] !== undefined) continue;
    out[key] = unquoteToml((match[2] ?? "").trim());
  }
  return out;
}

function unquoteToml(value: string): string {
  const triple = /^(['"]{3})([\s\S]*?)\1$/.exec(value);
  if (triple?.[2] !== undefined) return triple[2].trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export interface MarkdownItem {
  file: string;
  /** Name taken from frontmatter, or the file stem when absent. */
  name: string;
  description: string;
  degraded: boolean;
}

/** Read frontmatter-backed markdown files from a flat directory. */
export async function collectMarkdownItems(dir: string): Promise<MarkdownItem[]> {
  const files = await filesWithExtension(dir, [".md"]);
  const out: MarkdownItem[] = [];
  for (const file of files) {
    const item = await readMarkdownItem(file);
    if (item !== null) out.push(item);
  }
  return out;
}

/**
 * Read one `<skillDir>/SKILL.md` and return its routing metadata.
 *
 * Two details matter here and were both wrong in an earlier implementation:
 *
 * - The fallback name is the *directory* name, not the file stem. Every skill file
 *   is called `SKILL.md`, so a stem-based fallback names every undescribed skill
 *   `SKILL` and collapses them all into one catalog entry.
 * - Only that one file is read. Reading the whole directory would parse every
 *   companion document a skill ships and could pick up an unrelated name.
 */
export async function readSkillParts(
  file: string,
  dir: string,
): Promise<{ name: string; description: string; degraded: boolean }> {
  const fallback = path.basename(dir);
  const text = await readTextSafe(file);
  if (text === null) {
    return { name: fallback, description: "", degraded: true };
  }
  const fm = parseFrontmatter(text);
  return {
    name: fm.name ?? fallback,
    description: fm.description ?? "",
    degraded: fm.degraded || fm.description === undefined,
  };
}

/** Read one frontmatter-backed markdown file. Returns null when unreadable. */
export async function readMarkdownItem(file: string): Promise<MarkdownItem | null> {
  const text = await readTextSafe(file);
  if (text === null) return null;
  const fm = parseFrontmatter(text);
  const stem = path.basename(file).replace(/\.md$/i, "");
  const name = fm.name ?? stem;
  return {
    file,
    name,
    description: fm.description ?? "",
    degraded: fm.degraded || fm.description === undefined,
  };
}

/** Recursively collect markdown files under `dir`, bounded by depth. */
export async function collectMarkdownRecursive(
  dir: string,
  options: { maxDepth?: number; limit?: number } = {},
): Promise<string[]> {
  const maxDepth = options.maxDepth ?? 2;
  const limit = options.limit ?? 500;
  const out: string[] = [];

  async function walk(current: string, depth: number): Promise<void> {
    if (out.length >= limit || depth > maxDepth) return;
    for (const file of await filesWithExtension(current, [".md"])) {
      if (out.length >= limit) return;
      out.push(file);
    }
    for (const child of await subdirectories(current)) {
      if (out.length >= limit) return;
      await walk(child, depth + 1);
    }
  }

  await walk(dir, 0);
  return out.sort();
}

/** True when the directory exists and holds at least one entry. */
export async function hasEntries(dir: string): Promise<boolean> {
  return (await listDirSafe(dir)).length > 0;
}
