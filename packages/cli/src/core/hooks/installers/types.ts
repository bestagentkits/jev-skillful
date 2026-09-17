/**
 * Shared shapes for the four runtime installers.
 *
 * Every installer returns a result instead of throwing, and every one of them is idempotent
 * by construction. The caller (`install.ts`) collects results and reports them; it never has
 * to catch, because a failed installer should not stop the other three from being installed.
 */

import type { CatalogRuntime } from "../../catalog/types.js";

export interface InstallContext {
  homeDir: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Absolute path of the CLI entry the hook must invoke. */
  cliEntry: string;
  /** Node executable to invoke it with. */
  nodeBin: string;
  /** Timestamp used in backup filenames, so a run produces consistent names. */
  stamp: string;
  /**
   * Report what would change without touching anything.
   *
   * `install --dry-run` is the safe way to see which files would be modified, which matters
   * because two of the four targets are configuration files the user did not write.
   */
  dryRun?: boolean;
}

/** What an install did to one runtime. */
export interface InstallOutcome {
  runtime: CatalogRuntime;
  action: "installed" | "unchanged" | "skipped";
  target: string;
  backup?: string;
  notes: string[];
  error?: string;
}

/** What an uninstall did to one runtime. */
export interface UninstallOutcome {
  runtime: CatalogRuntime;
  action: "removed" | "absent" | "skipped";
  target: string;
  backup?: string;
  notes: string[];
  error?: string;
}

/**
 * The command a hook runtime executes.
 *
 * The marker is passed as a plain argument, so it survives shell and non-shell invocation,
 * and it is what `json-merge.ts` looks for when deciding which entries are ours.
 */
export function hookCommand(ctx: InstallContext): string {
  return `${quote(ctx.nodeBin)} ${quote(ctx.cliEntry)} hook ${MARKER_ARG}`;
}

/** Quoted the way both POSIX shells and Windows `cmd` accept. */
function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

/** Kept in sync with `SKILLFUL_HOOK_MARKER` in `json-merge.ts`. */
const MARKER_ARG = "--managed-by-skillful";
