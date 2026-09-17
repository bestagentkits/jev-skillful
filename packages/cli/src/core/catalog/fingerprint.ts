import { createHash } from "node:crypto";
import type { CatalogEntry } from "./types.js";

/**
 * Compute a fingerprint over the identity of every catalog entry.
 *
 * The fingerprint is one half of the route cache key, so it must change when the
 * meaning of the catalog changes and stay stable when only incidental details do.
 * It is therefore built from sorted `kind:runtime:scope:name:description` lines:
 *
 * - Adding, removing, renaming, or re-describing an entry changes it.
 * - Reordering files on disk, moving a skill between directories, or changing a
 *   file's modification time does not.
 *
 * Paths are deliberately excluded so that relocating a skills directory does not
 * invalidate cached routes for an otherwise identical catalog.
 */
export function catalogFingerprint(entries: readonly CatalogEntry[]): string {
  const identity = entries
    .map((entry) =>
      [entry.kind, entry.runtime, entry.scope, entry.name, entry.description].join("\u0000"),
    )
    .sort();

  const hash = createHash("sha256");
  for (const line of identity) {
    hash.update(line);
    hash.update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}
