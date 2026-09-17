import os from "node:os";
import { catalogFingerprint } from "./fingerprint.js";
import { findProjectRoot } from "./project-scope.js";
import { claudeCodeSource } from "./sources/claude-code.js";
import { codexSource } from "./sources/codex.js";
import { ompSource } from "./sources/omp.js";
import { piSource } from "./sources/pi.js";
import type { Catalog, CatalogEntry, CatalogRuntime, ScanContext } from "./types.js";

/** Environment variables the scanner is allowed to read. */
const ENV_ALLOWLIST = [
  "AGENTKIT_CODEX_SKILLS_ROOT",
  "AGENTKIT_OMP_HOME",
  "OMP_HOME",
  "PI_CODING_AGENT_DIR",
] as const;

const ALL_SOURCES = [claudeCodeSource, codexSource, piSource, ompSource];

export interface ScanOptions {
  /** Defaults to the real home directory. Tests always pass a fixture instead. */
  homeDir?: string;
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Limit the scan to some runtimes. Defaults to all of them. */
  runtimes?: readonly CatalogRuntime[];
}

/**
 * Scan every configured runtime surface and return a normalised catalog.
 *
 * Failures are per source and never abort the scan: a runtime whose configuration
 * is unreadable produces a warning, not an exception. The result is deterministic
 * for a given filesystem state, which is what makes the fingerprint usable as a
 * cache key.
 */
export async function scanCatalog(options: ScanOptions = {}): Promise<Catalog> {
  const homeDir = options.homeDir ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const projectDir = await findProjectRoot(cwd, homeDir);
  const env = pickEnv(options.env ?? process.env);

  const ctx: ScanContext = { homeDir, cwd, projectDir, env };
  const warnings: string[] = [];
  const collected: CatalogEntry[] = [];

  const wanted = options.runtimes ?? ALL_SOURCES.map((source) => source.runtime);
  for (const source of ALL_SOURCES) {
    if (!wanted.includes(source.runtime)) continue;
    try {
      collected.push(...(await source.scan(ctx)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`${source.runtime}: ${message}`);
    }
  }

  const entries = normalise(collected);
  return {
    entries,
    fingerprint: catalogFingerprint(entries),
    warnings,
  };
}

export { findProjectRoot, catalogFingerprint };

/** Deduplicate and order entries so the output is reproducible. */
function normalise(entries: readonly CatalogEntry[]): CatalogEntry[] {
  const byId = new Map<string, CatalogEntry>();
  const seenPhysical = new Set<string>();

  for (const entry of entries) {
    // Several items can legitimately share one source file: every MCP server in
    // `~/.claude.json` comes from that single file. The physical-duplicate key must
    // therefore include the item name, otherwise distinct servers collapse into one.
    const physicalKey = [entry.runtime, entry.kind, entry.name, entry.sourcePath].join("\u0000");
    if (seenPhysical.has(physicalKey)) continue;
    seenPhysical.add(physicalKey);

    const existing = byId.get(entry.id);
    if (existing === undefined || (existing.degraded === true && entry.degraded !== true)) {
      byId.set(entry.id, entry);
    }
  }

  return [...byId.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    if (a.runtime !== b.runtime) return a.runtime.localeCompare(b.runtime);
    if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
    return a.name.localeCompare(b.name);
  });
}

function pickEnv(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
