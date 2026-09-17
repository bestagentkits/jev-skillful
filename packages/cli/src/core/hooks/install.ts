/**
 * Install, uninstall and inspect the hooks for every runtime present on this machine.
 *
 * The orchestration is deliberately boring: detect, run each installer, collect outcomes,
 * never throw. An installer that fails is reported and the remaining runtimes are still
 * installed, because a user with four runtimes and one broken configuration should end up with
 * three working hooks rather than none.
 *
 * Installation is idempotent by construction. Each installer removes its own previous entries
 * and appends a fresh one, so a second `install` produces a byte-identical file and the run
 * reports `unchanged`.
 */

import { readFileSync, statSync } from "node:fs";
import { detectRuntimes, runtimeLocations } from "./detect.js";
import { installClaudeCode, uninstallClaudeCode } from "./installers/claude-code.js";
import { installCodex, uninstallCodex } from "./installers/codex.js";
import { installOmp, uninstallOmp } from "./installers/omp.js";
import { installPi, uninstallPi } from "./installers/pi.js";
import type { InstallContext, InstallOutcome, UninstallOutcome } from "./installers/types.js";
import type { CatalogRuntime } from "../catalog/types.js";

export interface InstallSummary {
  outcomes: InstallOutcome[];
  /** Runtimes that were looked for but whose configuration directory is absent. */
  missing: CatalogRuntime[];
  /** The interpreter the hook was pointed at, reported so a user can verify it. */
  nodeBin: string;
  cliEntry: string;
  dryRun: boolean;
}

export interface UninstallSummary {
  outcomes: UninstallOutcome[];
  missing: CatalogRuntime[];
  dryRun: boolean;
}

/**
 * Build the context shared by every installer.
 *
 * `cliEntry` must be an absolute path. A hook that resolves the CLI through `PATH` would
 * break the moment the hook runs in an environment that does not have it — and the whole
 * point of the hook is that it runs in whatever environment the agent has.
 */
export function buildInstallContext(options: {
  homeDir: string;
  env?: Readonly<Record<string, string | undefined>>;
  cliEntry: string;
  nodeBin?: string;
  stamp?: string;
  dryRun?: boolean;
}): InstallContext {
  const env = options.env ?? process.env;
  return {
    homeDir: options.homeDir,
    env,
    cliEntry: options.cliEntry,
    nodeBin: options.nodeBin ?? process.execPath,
    stamp: options.stamp ?? new Date().toISOString().replace(/[:.]/g, "-"),
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
  };
}

const INSTALLERS: Record<CatalogRuntime, (ctx: InstallContext) => InstallOutcome> = {
  "claude-code": installClaudeCode,
  codex: installCodex,
  pi: installPi,
  omp: installOmp,
};

const UNINSTALLERS: Record<CatalogRuntime, (ctx: InstallContext) => UninstallOutcome> = {
  "claude-code": uninstallClaudeCode,
  codex: uninstallCodex,
  pi: uninstallPi,
  omp: uninstallOmp,
};

/**
 * Install a hook for every runtime present.
 *
 * `only` restricts the run to a subset, which the CLI exposes as `--runtime`. Asking for a
 * runtime that is not installed is not an error: it is reported in `missing`.
 */
export function installHooks(ctx: InstallContext, only?: readonly CatalogRuntime[]): InstallSummary {
  const detected = detectRuntimes(ctx.homeDir, ctx.env);
  const missing = detected.filter((entry) => !entry.present).map((entry) => entry.runtime);

  const outcomes: InstallOutcome[] = [];
  for (const entry of detected) {
    if (!entry.present) continue;
    if (only !== undefined && !only.includes(entry.runtime)) continue;

    let outcome: InstallOutcome;
    try {
      outcome = INSTALLERS[entry.runtime](ctx);
    } catch (error) {
      // An installer is written not to throw, but the guarantee lives here as well, so one
      // unexpected failure cannot abort the remaining runtimes.
      outcome = {
        runtime: entry.runtime,
        action: "skipped",
        target: entry.hookTarget,
        notes: [],
        error: `Installer threw: ${(error as Error).message}`,
      };
    }
    outcomes.push(outcome);
  }

  return {
    outcomes,
    missing: only === undefined ? missing : missing.filter((runtime) => only.includes(runtime)),
    nodeBin: ctx.nodeBin,
    cliEntry: ctx.cliEntry,
    dryRun: ctx.dryRun === true,
  };
}

export function uninstallHooks(
  ctx: InstallContext,
  only?: readonly CatalogRuntime[],
): UninstallSummary {
  const detected = detectRuntimes(ctx.homeDir, ctx.env);
  const missing = detected
    .filter((entry) => !entry.present)
    .map((entry) => entry.runtime)
    .filter((runtime) => only === undefined || only.includes(runtime));

  const outcomes: UninstallOutcome[] = [];
  for (const entry of detected) {
    if (!entry.present) continue;
    if (only !== undefined && !only.includes(entry.runtime)) continue;

    let outcome: UninstallOutcome;
    try {
      outcome = UNINSTALLERS[entry.runtime](ctx);
    } catch (error) {
      outcome = {
        runtime: entry.runtime,
        action: "skipped",
        target: entry.hookTarget,
        notes: [],
        error: `Uninstaller threw: ${(error as Error).message}`,
      };
    }
    outcomes.push(outcome);
  }

  return { outcomes, missing, dryRun: ctx.dryRun === true };
}

export interface HookStatus {
  runtime: CatalogRuntime;
  present: boolean;
  /** True when a Skillful entry exists in the runtime's hook surface. */
  installed: boolean;
  target: string;
  detail: string;
}

/**
 * Report where each runtime's hook stands, for `skillful doctor`.
 *
 * Reads only. It never installs, repairs, or writes, because a diagnostic that changes state
 * is not a diagnostic.
 */
export function hookStatus(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>> = {},
): HookStatus[] {
  const detected = detectRuntimes(homeDir, env);
  const locations = new Map(runtimeLocations(homeDir, env).map((l) => [l.runtime, l] as const));

  return detected.map((entry) => {
    const location = locations.get(entry.runtime);
    const target = location?.hookTarget ?? entry.hookTarget;
    if (!entry.present) {
      return { runtime: entry.runtime, present: false, installed: false, target, detail: "Configuration directory not found" };
    }

    // Read-only inspection mirrors what the uninstaller would remove, so a status of
    // "installed" can never disagree with what `uninstall` actually does.
    const installed = entry.mechanism === "hook"
      ? hookFileContainsSkillful(target)
      : extensionDirExists(target);

    return {
      runtime: entry.runtime,
      present: true,
      installed,
      target,
      detail: installed ? "Skillful hook installed" : "No Skillful hook",
    };
  });
}

function hookFileContainsSkillful(filePath: string): boolean {
  try {
    return readFileSync(filePath, "utf8").includes("--managed-by-skillful");
  } catch {
    return false;
  }
}

function extensionDirExists(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
