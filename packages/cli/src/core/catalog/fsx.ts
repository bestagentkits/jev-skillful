import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Filesystem helpers that treat every failure as an empty result.
 *
 * Catalog scanning runs on machines we do not control, against directories that
 * may not exist, may be unreadable, or may change mid-scan. A single unreadable
 * item must never fail the whole scan, so nothing here throws.
 */

export interface SafeDirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

/** List a directory. Returns an empty array when it is missing or unreadable. */
export async function listDirSafe(dir: string): Promise<SafeDirEntry[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: SafeDirEntry[] = [];
  for (const entry of entries) {
    out.push({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    });
  }
  return out;
}

/** True when the path exists and is a directory. */
export async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** True when the path exists and is a regular file. */
export async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Read a UTF-8 text file, or null when it cannot be read. */
export async function readTextSafe(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** Read and parse a JSON file, or null when missing or malformed. */
export async function readJsonSafe<T = unknown>(file: string): Promise<T | null> {
  const text = await readTextSafe(file);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Subdirectories of `dir`, in filesystem order. */
export async function subdirectories(dir: string): Promise<string[]> {
  const entries = await listDirSafe(dir);
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) out.push(path.join(dir, entry.name));
  }
  return out;
}

/** Files directly inside `dir` matching an extension, sorted for stable output. */
export async function filesWithExtension(dir: string, extensions: string[]): Promise<string[]> {
  const wanted = new Set(extensions.map((ext) => ext.toLowerCase()));
  const entries = await listDirSafe(dir);
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile) continue;
    if (wanted.has(path.extname(entry.name).toLowerCase())) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out.sort();
}
