/**
 * The shared installer for runtimes that register hooks in a JSON file.
 *
 * Claude Code and Codex use the same shape — a `hooks.<Event>` array of `{matcher, hooks}`
 * entries whose commands receive the event JSON on stdin — so the only difference between
 * them is which file they read. Sharing the implementation rather than copying it means the
 * safety rules (backup, atomic write, remove-only-ours, idempotent) cannot drift apart.
 *
 * Every branch returns instead of throwing. One runtime's broken configuration must not
 * prevent the other runtimes from being installed.
 */

import { unlinkSync } from "node:fs";
import type { CatalogRuntime } from "../../catalog/types.js";
import {
  backupFile,
  type HookEntry,
  readJsonFile,
  removeSkillfulEntries,
  upsertSkillfulEntry,
  writeJsonAtomic,
} from "../json-merge.js";
import { hookCommand, type InstallContext, type InstallOutcome, type UninstallOutcome } from "./types.js";

interface HookSettings {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
}

export interface JsonHookSpec {
  runtime: CatalogRuntime;
  /** Absolute path of the JSON file to modify. */
  target: string;
  /** Event name, for example `UserPromptSubmit`. */
  event: string;
  /** Extra lines appended to the install notes, for runtime-specific caveats. */
  notes?: readonly string[];
}

/** Our entry: match every prompt, run the hook command. */
function ourEntry(ctx: InstallContext): HookEntry {
  return { matcher: "*", hooks: [{ type: "command", command: hookCommand(ctx) }] };
}

/**
 * Read the hooks table, or explain why it cannot be used.
 *
 * Returns `null` when the file is unusable, having appended the reason to `notes`.
 */
function readHooksTable(
  spec: JsonHookSpec,
  notes: string[],
): { settings: HookSettings; entries: HookEntry[] } | null {
  const read = readJsonFile<HookSettings>(spec.target);
  if (read.error !== undefined) {
    notes.push(read.error);
    return null;
  }

  const settings: HookSettings = read.data ?? {};
  const hooks = settings.hooks;

  if (hooks === undefined || hooks === null) {
    settings.hooks = {};
    return { settings, entries: [] };
  }
  if (typeof hooks !== "object" || Array.isArray(hooks)) {
    notes.push(`${spec.target} has a "hooks" key that is not an object. Leaving it untouched.`);
    return null;
  }

  const existing = hooks[spec.event];
  if (existing !== undefined && !Array.isArray(existing)) {
    notes.push(`${spec.target} has hooks.${spec.event} that is not an array. Leaving it untouched.`);
    return null;
  }

  return { settings, entries: Array.isArray(existing) ? existing : [] };
}

export function installJsonHook(ctx: InstallContext, spec: JsonHookSpec): InstallOutcome {
  const notes: string[] = [...(spec.notes ?? [])];

  const table = readHooksTable(spec, notes);
  if (table === null) {
    return { runtime: spec.runtime, action: "skipped", target: spec.target, notes, error: notes.at(-1) };
  }

  const { entries, changed, replaced } = upsertSkillfulEntry(table.entries, ourEntry(ctx));

  if (!changed) {
    notes.push("Skillful hook already present and current.");
    return { runtime: spec.runtime, action: "unchanged", target: spec.target, notes };
  }

  if (ctx.dryRun === true) {
    notes.push(`Would write ${entries.length} ${spec.event} entr${entries.length === 1 ? "y" : "ies"}.`);
    return { runtime: spec.runtime, action: "installed", target: spec.target, notes };
  }

  let backup: string | undefined;
  try {
    backup = backupFile(spec.target, ctx.stamp) ?? undefined;
    table.settings.hooks = { ...table.settings.hooks, [spec.event]: entries };
    writeJsonAtomic(spec.target, table.settings);
  } catch (error) {
    return {
      runtime: spec.runtime,
      action: "skipped",
      target: spec.target,
      notes,
      error: `Could not write ${spec.target}: ${(error as Error).message}`,
    };
  }

  if (replaced > 0) {
    notes.push(`Replaced ${replaced} previous Skillful entr${replaced === 1 ? "y" : "ies"}.`);
  }
  if (backup !== undefined) notes.push(`Backup: ${backup}`);
  return {
    runtime: spec.runtime,
    action: "installed",
    target: spec.target,
    ...(backup === undefined ? {} : { backup }),
    notes,
  };
}

export function uninstallJsonHook(ctx: InstallContext, spec: JsonHookSpec): UninstallOutcome {
  const notes: string[] = [];

  const read = readJsonFile<HookSettings>(spec.target);
  if (!read.existed) return { runtime: spec.runtime, action: "absent", target: spec.target, notes };
  if (read.error !== undefined) {
    return {
      runtime: spec.runtime,
      action: "skipped",
      target: spec.target,
      notes: [read.error],
      error: read.error,
    };
  }

  const settings: HookSettings = read.data ?? {};
  const existing = settings.hooks?.[spec.event];
  const { entries, removed } = removeSkillfulEntries(Array.isArray(existing) ? existing : []);

  if (removed === 0) {
    return {
      runtime: spec.runtime,
      action: "absent",
      target: spec.target,
      notes: ["No Skillful hook found."],
    };
  }

  if (ctx.dryRun === true) {
    notes.push(`Would remove ${removed} entr${removed === 1 ? "y" : "ies"}.`);
    return { runtime: spec.runtime, action: "removed", target: spec.target, notes };
  }

  let backup: string | undefined;
  try {
    backup = backupFile(spec.target, ctx.stamp) ?? undefined;
    if (settings.hooks !== undefined) {
      settings.hooks = { ...settings.hooks, [spec.event]: entries };
    }
    // The backup is taken above, so by the time the file is unlinked the original content is
    // already preserved on disk.
    pruneEmptyContainers(settings, spec.event, spec.target, notes);
    if (Object.keys(settings).length > 0) {
      writeJsonAtomic(spec.target, settings);
    }
  } catch (error) {
    return {
      runtime: spec.runtime,
      action: "skipped",
      target: spec.target,
      notes,
      error: `Could not write ${spec.target}: ${(error as Error).message}`,
    };
  }

  notes.push(`Removed ${removed} entr${removed === 1 ? "y" : "ies"}.`);
  if (backup !== undefined) notes.push(`Backup: ${backup}`);
  return {
    runtime: spec.runtime,
    action: "removed",
    target: spec.target,
    ...(backup === undefined ? {} : { backup }),
    notes,
  };
}

/**
 * Remove the containers our entry left behind once they hold nothing.
 *
 * Uninstall is required to leave the configuration as it was found, and an emptied
 * `hooks.UserPromptSubmit: []` is not that: it is a visible trace in a diff, and on the next
 * install it is a permanent artefact. So an emptied event array is dropped, and if that
 * empties the `hooks` object, so is it.
 *
 * When nothing at all remains, the file itself is removed. That is safe because an empty JSON
 * object and an absent file are the same thing to every reader of these files: the runtime
 * treats a missing settings file as an empty one, which is exactly the state a first install
 * started from.
 */
function pruneEmptyContainers(
  settings: HookSettings,
  event: string,
  target: string,
  notes: string[],
): void {
  const table = settings.hooks;
  if (table === undefined) return;

  if (Array.isArray(table[event]) && table[event].length === 0) {
    delete table[event];
  }
  if (Object.keys(table).length === 0) {
    delete settings.hooks;
  }

  if (Object.keys(settings).length > 0) return;

  try {
    unlinkSync(target);
    notes.push(`Removed ${target}, which held nothing but the Skillful hook.`);
  } catch {
    // Leaving an empty object behind is harmless, so a failed unlink is not worth failing over.
  }
}
