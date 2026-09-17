/**
 * Catalog types.
 *
 * A catalog entry is one thing the user could load into an agent session: a skill,
 * an MCP server, a subagent, a slash command, or a rule file. Entries are discovered
 * from the configuration surfaces of the supported runtimes and normalised into this
 * shape so the router can treat them uniformly.
 */

export const CATALOG_KINDS = ["skill", "mcp", "agent", "command", "rule"] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];

export const CATALOG_RUNTIMES = ["claude-code", "codex", "pi", "omp"] as const;
export type CatalogRuntime = (typeof CATALOG_RUNTIMES)[number];

export const CATALOG_SCOPES = ["global", "project"] as const;
export type CatalogScope = (typeof CATALOG_SCOPES)[number];

export interface CatalogEntry {
  /**
   * Stable identity across scans. Derived from runtime, kind, and the
   * runtime-local name so that moving a directory does not change it.
   */
  id: string;
  kind: CatalogKind;
  /** Runtime-local name, for example `ak-brainstorm` or `postgres`. */
  name: string;
  /**
   * Short description used for retrieval and shown to Jev. Never contains the
   * body of a skill file. Empty when the source had no description.
   */
  description: string;
  runtime: CatalogRuntime;
  scope: CatalogScope;
  /** Absolute path of the file or config that produced this entry. */
  sourcePath: string;
  /**
   * Routing-intent text, when the source provides it. Used by retrieval and sent to the model.
   */
  whenToUse?: string;
  /**
   * True when the entry was found but its metadata could not be read cleanly
   * (malformed frontmatter, unreadable file, missing required fields). Degraded
   * entries are still returned so a single broken item cannot fail the scan.
   */
  degraded?: boolean;
  /** Kind-specific extras such as an MCP server command or URL. */
  meta?: Record<string, string>;
}

export interface ScanContext {
  /** Directory treated as the user's home. Injected so tests never touch the real home. */
  homeDir: string;
  /** Working directory used to resolve project-scoped surfaces. */
  cwd: string;
  /**
   * Resolved project root, or null when the working directory has no project
   * marker. Resolved once by the scanner so every source agrees on the boundary
   * instead of each walking the filesystem independently.
   */
  projectDir: string | null;
  /** Environment snapshot. Only a small allowlist of variables is read. */
  env: Readonly<Record<string, string | undefined>>;
}

export interface CatalogSource {
  runtime: CatalogRuntime;
  /** Discover every entry this runtime's configuration surfaces expose. */
  scan(ctx: ScanContext): Promise<CatalogEntry[]>;
}

export interface Catalog {
  entries: CatalogEntry[];
  /** sha256 over the normalised, order-independent identity of every entry. */
  fingerprint: string;
  /** Non-fatal problems encountered while scanning, one line each. */
  warnings: string[];
}

/** Build the stable id for an entry. Exported so sources stay consistent. */
export function catalogId(
  runtime: CatalogRuntime,
  kind: CatalogKind,
  name: string,
  scope: CatalogScope,
): string {
  return `${runtime}:${kind}:${scope}:${name}`;
}

/** Convert a filesystem name into the runtime-local name agents refer to. */
export function normaliseName(raw: string): string {
  return raw
    .trim()
    .replace(/\.(md|toml|json|ya?ml)$/i, "")
    .trim();
}

/**
 * Collapse a description to a single line, bounded in length.
 *
 * Descriptions travel to the model on every route request, so they are kept
 * short on purpose rather than truncated at request time.
 */
export function normaliseDescription(raw: string, limit = 200): string {
  const oneLine = raw.replace(/\s+/g, " ").trim();
  if (oneLine.length <= limit) return oneLine;
  return `${oneLine.slice(0, limit - 1).trimEnd()}…`;
}
