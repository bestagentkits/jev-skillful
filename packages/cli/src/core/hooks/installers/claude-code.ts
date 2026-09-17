/**
 * Install the hook into `~/.claude/settings.json`.
 *
 * Claude Code's contract, verified against the settings already on this machine: a hook
 * definition is `{matcher, hooks: [{type: "command", command}]}` inside `hooks.UserPromptSubmit`,
 * and the command receives the event JSON on stdin and answers with
 * `hookSpecificOutput.additionalContext` on stdout.
 *
 * The settings file is shared. It already held fourteen hook events and other tools' entries
 * before this installer ran, so the only safe operation is: read everything, remove exactly
 * our own entries, append ours, write it back atomically behind a backup.
 */

import path from "node:path";
import type { CatalogRuntime } from "../../catalog/types.js";
import { installJsonHook, uninstallJsonHook, type JsonHookSpec } from "./json-hook.js";
import type { InstallContext, InstallOutcome, UninstallOutcome } from "./types.js";

const RUNTIME: CatalogRuntime = "claude-code";

function spec(ctx: InstallContext): JsonHookSpec {
  return {
    runtime: RUNTIME,
    target: path.join(ctx.homeDir, ".claude", "settings.json"),
    event: "UserPromptSubmit",
  };
}

export function installClaudeCode(ctx: InstallContext): InstallOutcome {
  return installJsonHook(ctx, spec(ctx));
}

export function uninstallClaudeCode(ctx: InstallContext): UninstallOutcome {
  return uninstallJsonHook(ctx, spec(ctx));
}
