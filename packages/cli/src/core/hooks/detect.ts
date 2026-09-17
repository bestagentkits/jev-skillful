/**
 * Which agent runtimes are installed on this machine.
 *
 * Presence is decided by the **configuration directory**, not by a binary on `PATH`. A user
 * who runs an agent through a wrapper, a version manager, or an editor integration still has
 * a configuration directory and still needs a hook installed there, and a user with a stale
 * binary on `PATH` but no configuration would get a hook written into a directory nothing
 * reads. The directory is the thing the hook has to live in, so the directory is the test.
 */

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { CatalogRuntime } from "../catalog/types.js";

export interface RuntimeLocation {
  runtime: CatalogRuntime;
  /** Directory that must exist for the runtime to be considered installed. */
  configDir: string;
  /** Where this runtime's hook or extension is written. Relative to `configDir` for file hooks. */
  hookTarget: string;
  /** The mechanism this runtime uses, which decides the installer. */
  mechanism: "hook" | "extension";
}

export interface DetectedRuntime extends RuntimeLocation {
  present: boolean;
}

/**
 * Resolve the configuration directory of every supported runtime.
 *
 * Environment overrides are honoured because the catalog scanner already honours them, and
 * a hook written to a different root than the scanner reads would route against a catalog
 * the agent cannot load.
 */
export function runtimeLocations(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>> = {},
): RuntimeLocation[] {
  const claudeDir = path.join(homeDir, ".claude");
  const codexDir = env["CODEX_HOME"] ?? path.join(homeDir, ".codex");
  const piDir = env["PI_HOME"] ?? path.join(homeDir, ".pi", "agent");
  const ompDir =
    env["OMP_HOME"] ?? env["AGENTKIT_OMP_HOME"] ?? path.join(homeDir, ".omp", "agent");

  return [
    {
      runtime: "claude-code",
      configDir: claudeDir,
      hookTarget: path.join(claudeDir, "settings.json"),
      mechanism: "hook",
    },
    {
      runtime: "codex",
      configDir: codexDir,
      // Codex reads hook definitions from hooks.json. `config.toml` carries a `[hooks.state]`
      // table, but that table is a trust ledger of `path -> trusted_hash` for hook scripts,
      // not a list of hooks. Measured, not assumed: see docs/architecture.md.
      hookTarget: path.join(codexDir, "hooks.json"),
      mechanism: "hook",
    },
    {
      runtime: "pi",
      configDir: piDir,
      hookTarget: path.join(piDir, "extensions", "skillful"),
      mechanism: "extension",
    },
    {
      runtime: "omp",
      configDir: ompDir,
      hookTarget: path.join(ompDir, "extensions", "skillful"),
      mechanism: "extension",
    },
  ];
}

/** True when the path exists and is a directory rather than a file. */
function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Detect every runtime, marking which are installed.
 *
 * Never throws. An unreadable home directory produces a list where nothing is present,
 * which is a truthful answer and lets the caller report it.
 */
export function detectRuntimes(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>> = {},
): DetectedRuntime[] {
  return runtimeLocations(homeDir, env).map((location) => {
    // A hook target may be a directory (extensions) or a file (settings). Either counts as
    // evidence the runtime is configured, so both are accepted for presence.
    const present = isDirectory(location.configDir) || existsSync(location.configDir);
    return { ...location, present };
  });
}

/** The locations that are actually installed, in a stable order. */
export function presentRuntimes(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>> = {},
): DetectedRuntime[] {
  return detectRuntimes(homeDir, env).filter((entry) => entry.present);
}
