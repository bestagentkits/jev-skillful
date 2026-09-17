/**
 * Install the hook into `~/.codex/hooks.json`.
 *
 * **This target was measured, not assumed.** Two candidate locations existed on the machine,
 * so both were inspected and one was probed by running the agent:
 *
 * - `~/.codex/hooks.json` holds real hook definitions: `hooks.UserPromptSubmit` is an array of
 *   `{matcher, hooks: [{type, command, commandWindows}]}`, exactly the Claude Code shape.
 * - `~/.codex/config.toml` has a `[hooks]` table, but its only child is `[hooks.state]`, a
 *   ledger of `path -> trusted_hash` covering twenty-five entries. It records which hook
 *   scripts Codex has been told to trust; it does not define any hooks.
 *
 * A probe confirmed which one is live: a temporary entry appended to `hooks.json` produced
 * `hook: UserPromptSubmit` lines in Codex's own output, so the file is read and its hooks run.
 *
 * The probe also surfaced the caveat this installer has to report rather than hide. The probe
 * command did not itself execute, while the pre-existing hooks — all of which are `.cjs` files
 * under `~/.codex/hooks/` with a `trusted_hash` recorded in `config.toml` — did. Codex appears
 * to gate hook execution on that trust ledger, so a freshly installed hook may need the user to
 * approve it once before it takes effect. This installer does not fabricate a `trusted_hash`
 * for itself: writing into another tool's security ledger to silently authorise our own code is
 * not a decision an installer should make on the user's behalf.
 */

import path from "node:path";
import type { CatalogRuntime } from "../../catalog/types.js";
import { installJsonHook, uninstallJsonHook, type JsonHookSpec } from "./json-hook.js";
import type { InstallContext, InstallOutcome, UninstallOutcome } from "./types.js";

const RUNTIME: CatalogRuntime = "codex";

const TRUST_NOTE =
  "Codex keeps a trust ledger in ~/.codex/config.toml ([hooks.state], path -> trusted_hash) and appears to gate hook execution on it. If the hook does not fire, run Codex once and approve the Skillful hook when it asks. Skillful deliberately does not write to that ledger itself.";

function spec(ctx: InstallContext): JsonHookSpec {
  return {
    runtime: RUNTIME,
    target: path.join(ctx.env["CODEX_HOME"] ?? path.join(ctx.homeDir, ".codex"), "hooks.json"),
    event: "UserPromptSubmit",
    notes: [TRUST_NOTE],
  };
}

export function installCodex(ctx: InstallContext): InstallOutcome {
  return installJsonHook(ctx, spec(ctx));
}

export function uninstallCodex(ctx: InstallContext): UninstallOutcome {
  return uninstallJsonHook(ctx, spec(ctx));
}
