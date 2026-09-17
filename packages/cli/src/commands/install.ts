/**
 * `skillful install` and `skillful uninstall`.
 *
 * The command is a thin reporter over `installHooks`/`uninstallHooks`. It exists so a user can
 * see exactly which files were touched, which were backed up, and which runtimes were skipped —
 * installing into another program's configuration file should never be something that happens
 * silently.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CatalogRuntime } from "../core/catalog/types.js";
import { buildInstallContext, installHooks, uninstallHooks } from "../core/hooks/install.js";

export interface InstallCommandOptions {
  homeDir?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Absolute path to the CLI entry the hook should call. */
  cliEntry?: string;
  runtimes?: readonly CatalogRuntime[];
  dryRun?: boolean;
  json?: boolean;
}

/**
 * Resolve the CLI entry point to embed in a hook.
 *
 * An absolute path, deliberately. A hook that resolves `skillful` through `PATH` breaks in any
 * environment that does not have it — and a hook's whole job is to run inside whatever
 * environment the agent happens to have.
 */
export function resolveCliEntry(): string {
  // `src/commands/install.ts` and `dist/commands/install.js` are both three levels below the
  // package root, so one relative hop works in source and in build output alike.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "bin.js");
}

function describeAction(action: string): string {
  switch (action) {
    case "installed":
      return "installed";
    case "unchanged":
      return "already installed";
    case "removed":
      return "removed";
    case "absent":
      return "not installed";
    default:
      return "skipped";
  }
}

export async function installCommand(options: InstallCommandOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env["HOME"] ?? ".";
  const ctx = buildInstallContext({
    homeDir,
    env,
    cliEntry: options.cliEntry ?? resolveCliEntry(),
    dryRun: options.dryRun === true,
  });

  const summary = installHooks(ctx, options.runtimes);

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  }

  const out: string[] = [];
  out.push(summary.dryRun ? "Skillful hook install (dry run)" : "Skillful hook install");
  out.push(`  interpreter: ${summary.nodeBin}`);
  out.push(`  entry:       ${summary.cliEntry}`);
  out.push("");

  if (summary.outcomes.length === 0) {
    out.push("  No supported agent runtime found on this machine.");
  }

  for (const outcome of summary.outcomes) {
    out.push(`  ${outcome.runtime}: ${describeAction(outcome.action)}`);
    out.push(`    target: ${outcome.target}`);
    for (const note of outcome.notes) out.push(`    ${note}`);
    if (outcome.error !== undefined) out.push(`    error: ${outcome.error}`);
  }

  if (summary.missing.length > 0) {
    out.push("");
    out.push(`  Not installed: ${summary.missing.join(", ")}`);
  }

  if (summary.dryRun) {
    out.push("");
    out.push("  Dry run: nothing was written.");
  } else if (summary.outcomes.some((outcome) => outcome.action === "installed")) {
    out.push("");
    out.push("  Restart your agent session for the hook to take effect.");
  }

  process.stdout.write(`${out.join("\n")}\n`);
  return 0;
}

export async function uninstallCommand(options: InstallCommandOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env["HOME"] ?? ".";
  const ctx = buildInstallContext({
    homeDir,
    env,
    cliEntry: options.cliEntry ?? resolveCliEntry(),
    dryRun: options.dryRun === true,
  });

  const summary = uninstallHooks(ctx, options.runtimes);

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  }

  const out: string[] = [];
  out.push(summary.dryRun ? "Skillful hook uninstall (dry run)" : "Skillful hook uninstall");
  out.push("");

  if (summary.outcomes.length === 0) {
    out.push("  No supported agent runtime found on this machine.");
  }

  for (const outcome of summary.outcomes) {
    out.push(`  ${outcome.runtime}: ${describeAction(outcome.action)}`);
    out.push(`    target: ${outcome.target}`);
    for (const note of outcome.notes) out.push(`    ${note}`);
    if (outcome.error !== undefined) out.push(`    error: ${outcome.error}`);
  }

  if (summary.dryRun) {
    out.push("");
    out.push("  Dry run: nothing was written.");
  }

  process.stdout.write(`${out.join("\n")}\n`);
  return 0;
}
