/**
 * Install the extension into `~/.pi/agent/extensions/skillful/`.
 *
 * Pi discovers extensions from that directory automatically, so there is no registry to merge
 * and nothing outside our own directory is touched.
 */

import path from "node:path";
import type { CatalogRuntime } from "../../catalog/types.js";
import { installExtension, uninstallExtension, type ExtensionSpec } from "./extension.js";
import type { InstallContext, InstallOutcome, UninstallOutcome } from "./types.js";

const RUNTIME: CatalogRuntime = "pi";

function spec(ctx: InstallContext): ExtensionSpec {
  return {
    runtime: RUNTIME,
    agentHome: ctx.env["PI_HOME"] ?? path.join(ctx.homeDir, ".pi", "agent"),
  };
}

export function installPi(ctx: InstallContext): InstallOutcome {
  return installExtension(ctx, spec(ctx));
}

export function uninstallPi(ctx: InstallContext): UninstallOutcome {
  return uninstallExtension(ctx, spec(ctx));
}
