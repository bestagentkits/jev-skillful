import type { CatalogEntry, CatalogKind, CatalogRuntime, CatalogScope } from "./types.js";
import { catalogId } from "./types.js";

/**
 * Entry builders.
 *
 * Every source produces the same two shapes: an item described by frontmatter
 * (skills and agents) and an item described by a config key (MCP servers,
 * commands, rules). Centralising construction keeps ids and degraded flags
 * consistent across runtimes.
 */

export interface DescribedItem {
  name: string;
  description: string;
  whenToUse?: string;
  sourcePath: string;
  degraded?: boolean;
  meta?: Record<string, string>;
}

export function buildEntry(
  runtime: CatalogRuntime,
  kind: CatalogKind,
  scope: CatalogScope,
  item: DescribedItem,
): CatalogEntry {
  const entry: CatalogEntry = {
    id: catalogId(runtime, kind, item.name, scope),
    kind,
    name: item.name,
    description: item.description,
    runtime,
    scope,
    sourcePath: item.sourcePath,
  };
  if (item.whenToUse !== undefined && item.whenToUse.length > 0) entry.whenToUse = item.whenToUse;
  if (item.degraded === true) entry.degraded = true;
  if (item.meta !== undefined) entry.meta = item.meta;
  return entry;
}
