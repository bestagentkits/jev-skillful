/**
 * Install the extension into the OMP agent home's `extensions/skillful/`.
 *
 * OMP shares Pi's extension mechanism, so the same generated file works for both. Only the
 * home directory differs, and it honours the same two environment overrides the catalog
 * scanner already reads, so an install never lands somewhere the scanner does not look.
 */

import path from "node:path";
import type { CatalogRuntime } from "../../catalog/types.js";
import { installExtension, uninstallExtension, type ExtensionSpec } from "./extension.js";
import type { InstallContext, InstallOutcome, UninstallOutcome } from "./types.js";

const RUNTIME: CatalogRuntime = "omp";

function agentHome(ctx: InstallContext): string {
  return (
    ctx.env["OMP_HOME"] ??
    ctx.env["AGENTKIT_OMP_HOME"] ??
    path.join(ctx.homeDir, ".omp", "agent")
  );
}

function spec(ctx: InstallContext): ExtensionSpec {
  return { runtime: RUNTIME, agentHome: agentHome(ctx) };
}

export function installOmp(ctx: InstallContext): InstallOutcome {
  return installExtension(ctx, spec(ctx));
}

export function uninstallOmp(ctx: InstallContext): UninstallOutcome {
  return uninstallExtension(ctx, spec(ctx));
}
