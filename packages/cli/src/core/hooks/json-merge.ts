/**
 * Reading and writing the runtime configuration files we share with other tools.
 *
 * This is the most dangerous module in the project. `~/.claude/settings.json` and
 * `~/.codex/hooks.json` belong to the user, and other tools — AgentKit among them — also
 * write hooks into them. Every rule here exists to protect data we did not create:
 *
 * - A file we cannot parse is never overwritten. Refusing to act is recoverable; clobbering
 *   a malformed-but-salvageable settings file is not.
 * - Every write is preceded by a timestamped backup, and the write itself is a temp file
 *   plus a rename, so an interrupted hook cannot leave a truncated configuration behind.
 * - Only entries carrying our marker are touched. Everything else keeps its exact position.
 */

import { closeSync, copyFileSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The token that identifies a hook entry as ours.
 *
 * It is a plain argument rather than a shell comment, so it survives whether or not the
 * runtime invokes the command through a shell, and it is not a JSON key, so we never add an
 * unknown field to a schema we do not control. Our CLI accepts and ignores it.
 */
export const SKILLFUL_HOOK_MARKER = "--managed-by-skillful";

export interface JsonReadResult<T> {
  data: T | null;
  /** True when the file existed, whether or not it could be parsed. */
  existed: boolean;
  /** Set when the file existed but could not be read or parsed. */
  error?: string;
}

/**
 * Read a JSON file without ever throwing.
 *
 * A missing file is not an error: it is the normal first-install case, and it means "start
 * from an empty object".
 */
export function readJsonFile<T>(filePath: string): JsonReadResult<T> {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { data: null, existed: false };
    return { data: null, existed: true, error: `Could not read ${filePath}: ${code ?? "unknown"}` };
  }

  if (raw.trim().length === 0) {
    // An empty file is treated as an empty object rather than as unparseable. Some tools
    // leave a zero-byte file behind, and refusing to install over one would be unhelpful.
    return { data: {} as T, existed: true };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return { data: parsed as T, existed: true };
  } catch {
    return {
      data: null,
      existed: true,
      error: `${filePath} is not valid JSON. Leaving it untouched rather than risk destroying settings we did not write.`,
    };
  }
}

/** Ensure a directory exists, including parents. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/**
 * Copy a file to `<file>.bak.skillful.<stamp>` before it is modified.
 *
 * Returns the backup path, or null when there was nothing to back up. A failed backup is
 * reported by throwing, because writing over an unbacked-up user file is the one outcome
 * this module must not allow.
 */
export function backupFile(filePath: string, stamp: string): string | null {
  if (!existsSyncFile(filePath)) return null;
  const backupPath = `${filePath}.bak.skillful.${stamp}`;
  copyFileSync(filePath, backupPath);
  return backupPath;
}

function existsSyncFile(filePath: string): boolean {
  try {
    readFileSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write JSON atomically: temp file in the same directory, fsync, then rename.
 *
 * The rename is the commit point. Two hooks running at once can both write, and the loser's
 * rename simply replaces the winner's file with equally valid content rather than
 * interleaving two writes into one corrupt document.
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));

  const tempPath = `${filePath}.skillful.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(data, null, 2)}\n`;

  let fd: number | undefined;
  try {
    fd = openSync(tempPath, "w", 0o600);
    writeFileSync(fd, body, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, filePath);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Closing an already-broken descriptor is not worth reporting.
      }
    }
    try {
      unlinkSync(tempPath);
    } catch {
      // The temp file may not exist if opening it failed.
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Hook entry shapes
// ---------------------------------------------------------------------------

/** One command inside a hook entry. Claude Code and Codex both use `type` plus `command`. */
export interface HookCommand {
  type: string;
  command: string;
  commandWindows?: string;
  [key: string]: unknown;
}

/** One hook entry: a matcher plus the commands to run. */
export interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
  [key: string]: unknown;
}

/** True when a command string is one we installed. */
export function isSkillfulCommand(command: unknown): boolean {
  return typeof command === "string" && command.includes(SKILLFUL_HOOK_MARKER);
}

/** True when any command in an entry is ours. */
export function isSkillfulEntry(entry: HookEntry): boolean {
  return Array.isArray(entry.hooks) && entry.hooks.some((hook) => isSkillfulCommand(hook?.command));
}

/**
 * Remove every entry of ours, leaving the order of every other entry exactly as it was.
 *
 * Rebuilding the array instead of splicing lets the caller append our fresh entry at the
 * end, which is what makes a second `install` produce no change: the array is identical to
 * the one the first install left behind.
 */
export function removeSkillfulEntries(entries: readonly HookEntry[]): {
  entries: HookEntry[];
  removed: number;
} {
  const kept: HookEntry[] = [];
  let removed = 0;
  for (const entry of entries) {
    if (entry !== null && typeof entry === "object" && isSkillfulEntry(entry)) {
      removed += 1;
    } else {
      kept.push(entry);
    }
  }
  return { entries: kept, removed };
}

/**
 * Install our entry, replacing any previous one.
 *
 * Returns `changed: false` when the resulting array is byte-identical to the input, which is
 * the definition of idempotent this project uses: running install twice leaves the file
 * untouched the second time, including its mtime.
 */
export function upsertSkillfulEntry(
  entries: readonly HookEntry[],
  entry: HookEntry,
): { entries: HookEntry[]; changed: boolean; replaced: number } {
  const { entries: kept, removed } = removeSkillfulEntries(entries);
  const next = [...kept, entry];

  const changed = JSON.stringify(next) !== JSON.stringify(entries);
  return { entries: next, changed, replaced: removed };
}
