/**
 * Shared installer for the two extension-based runtimes.
 *
 * Pi and OMP both discover extensions from a directory under their agent home, so installing
 * for either is the same operation against a different root: write `index.ts` into
 * `<agentHome>/extensions/skillful/`, and remove that one directory to uninstall.
 *
 * Nothing outside our own directory is touched. There is no shared registry file to merge,
 * which makes this the least dangerous of the two installation mechanisms.
 */

import { existsSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CatalogRuntime } from "../../catalog/types.js";
import { ensureDir } from "../json-merge.js";
import { extensionSource } from "./extension-source.js";
import type { InstallContext, InstallOutcome, UninstallOutcome } from "./types.js";

/** The directory name our extension occupies, which is also our marker on disk. */
export const EXTENSION_DIR_NAME = "skillful";

export interface ExtensionSpec {
  runtime: CatalogRuntime;
  /** The runtime's agent home, for example `~/.pi/agent`. */
  agentHome: string;
}

/**
 * Write source text atomically: temp file in the same directory, then rename.
 *
 * The JSON writer cannot be reused here because it pretty-prints and appends a newline, which
 * would corrupt a source file. The atomicity comes from the temp-file-plus-rename, and that is
 * the part worth sharing, so it is repeated against the same primitive.
 */
function writeTextAtomic(filePath: string, body: string): void {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.skillful.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, body, "utf8");
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // The temp file may not exist.
    }
    throw error;
  }
}

export function installExtension(ctx: InstallContext, spec: ExtensionSpec): InstallOutcome {
  const target = path.join(spec.agentHome, "extensions", EXTENSION_DIR_NAME);
  const entry = path.join(target, "index.ts");
  const notes: string[] = [];

  const body = extensionSource(ctx);

  if (existsSync(entry)) {
    try {
      if (readFileSync(entry, "utf8") === body) {
        notes.push("Extension already present and current.");
        return { runtime: spec.runtime, action: "unchanged", target, notes };
      }
    } catch {
      // An unreadable file is rewritten below rather than reported: it lives in a directory
      // we own, so replacing it cannot destroy anything the user wrote.
    }
  }

  if (ctx.dryRun === true) {
    notes.push(`Would write ${entry}.`);
    return { runtime: spec.runtime, action: "installed", target, notes };
  }

  try {
    writeTextAtomic(entry, body);
  } catch (error) {
    return {
      runtime: spec.runtime,
      action: "skipped",
      target,
      notes,
      error: `Could not write ${entry}: ${(error as Error).message}`,
    };
  }

  notes.push(`Wrote ${entry}`);
  notes.push("Extensions run with your full user permissions. This one only spawns the Skillful CLI.");
  return { runtime: spec.runtime, action: "installed", target, notes };
}

export function uninstallExtension(ctx: InstallContext, spec: ExtensionSpec): UninstallOutcome {
  const target = path.join(spec.agentHome, "extensions", EXTENSION_DIR_NAME);
  const notes: string[] = [];

  if (!existsSync(target)) {
    return { runtime: spec.runtime, action: "absent", target, notes: ["No Skillful extension found."] };
  }

  if (ctx.dryRun === true) {
    notes.push(`Would remove ${target}.`);
    return { runtime: spec.runtime, action: "removed", target, notes };
  }

  try {
    // Only the directory we created, and only ever by name.
    rmSync(target, { recursive: true, force: true });
  } catch (error) {
    return {
      runtime: spec.runtime,
      action: "skipped",
      target,
      notes,
      error: `Could not remove ${target}: ${(error as Error).message}`,
    };
  }

  notes.push(`Removed ${target}.`);
  return { runtime: spec.runtime, action: "removed", target, notes };
}
