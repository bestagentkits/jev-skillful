/**
 * Keeping the log from growing without bound.
 *
 * Rotation is size-based and retention is age-based, and both run **on a fraction of writes**
 * rather than on every write. Checking the file size on every prompt would put a `stat` call on
 * the hook's critical path for the benefit of a decision that is only interesting occasionally.
 *
 * The failure mode this guards against is not disk space in the abstract. It is a log that grows
 * until a user notices, at which point it is large enough that reading it for a report is slow, and
 * the natural reaction is to delete it — losing the history that made the tool worth measuring.
 */

import { existsSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";

/** Rotate once the active log passes this size. */
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/** Delete rotated logs older than this. */
export const DEFAULT_RETENTION_DAYS = 30;

/** How many rotated logs to keep. */
export const DEFAULT_MAX_ROTATED = 3;

/** Run maintenance roughly every Nth write, so the hook pays for it rarely. */
export const MAINTENANCE_INTERVAL = 200;

export interface RetentionOptions {
  filePath: string;
  maxBytes?: number;
  retentionDays?: number;
  maxRotated?: number;
  now?: number;
  /** Counter value; maintenance runs when this is a multiple of `MAINTENANCE_INTERVAL`. */
  writeCount?: number;
}

export interface RetentionResult {
  rotated: boolean;
  /** Rotated log files removed by age or count. */
  removed: string[];
}

/** Rotated paths for a log, newest first: `<file>.1` is the most recent rotation. */
export function rotatedPaths(filePath: string, maxRotated: number): string[] {
  return Array.from({ length: maxRotated }, (_, index) => `${filePath}.${index + 1}`);
}

/**
 * Rotate and prune.
 *
 * Never throws. Maintenance is housekeeping on top of an optional feature, so a failure here is
 * not worth reporting to a user who is in the middle of a prompt.
 */
export function maintain(options: RetentionOptions): RetentionResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const maxRotated = options.maxRotated ?? DEFAULT_MAX_ROTATED;
  const now = options.now ?? Date.now();
  const writeCount = options.writeCount;

  const result: RetentionResult = { rotated: false, removed: [] };

  if (writeCount !== undefined && writeCount % MAINTENANCE_INTERVAL !== 0) return result;

  try {
    if (!existsSync(options.filePath)) return result;

    const size = statSync(options.filePath).size;
    if (size >= maxBytes) {
      rotate(options.filePath, maxRotated, result);
    }

    pruneByAge(options.filePath, maxRotated, retentionDays, now, result);
  } catch {
    // A read-only directory or a concurrent rotation. Neither is worth failing a prompt over.
  }

  return result;
}

/** Shift `.1` to `.2`, and so on, then move the active log to `.1`. */
function rotate(filePath: string, maxRotated: number, result: RetentionResult): void {
  const oldest = `${filePath}.${maxRotated}`;
  if (existsSync(oldest)) {
    unlinkSync(oldest);
    result.removed.push(oldest);
  }

  for (let index = maxRotated - 1; index >= 1; index -= 1) {
    const from = `${filePath}.${index}`;
    if (existsSync(from)) renameSync(from, `${filePath}.${index + 1}`);
  }

  renameSync(filePath, `${filePath}.1`);
  result.rotated = true;
}

/** Remove rotated logs past the retention window. */
function pruneByAge(
  filePath: string,
  maxRotated: number,
  retentionDays: number,
  now: number,
  result: RetentionResult,
): void {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;

  for (const path of rotatedPaths(filePath, maxRotated)) {
    if (!existsSync(path)) continue;
    if (statSync(path).mtimeMs >= cutoff) continue;
    try {
      rmSync(path, { force: true });
      result.removed.push(path);
    } catch {
      // Another process may have removed it first.
    }
  }
}
