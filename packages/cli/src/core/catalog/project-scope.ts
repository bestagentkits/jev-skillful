import path from "node:path";
import { isDirectory, isFile } from "./fsx.js";

/** Markers that identify a directory as the root of a project. */
const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  ".claude",
  ".codex",
  ".pi",
  ".omp",
];

/**
 * Find the project root for the current working directory.
 *
 * Walks upward from `cwd` and returns the nearest directory holding a project
 * marker, mirroring how git locates a repository. The walk stops at `homeDir` and
 * at the filesystem root so that a stray marker in a home directory or at `/`
 * cannot make every session look like it belongs to one giant project.
 *
 * Returns null when no project root is found, in which case only global surfaces
 * are scanned.
 */
export async function findProjectRoot(cwd: string, homeDir: string): Promise<string | null> {
  const start = path.resolve(cwd);
  const stop = path.resolve(homeDir);
  let current = start;

  for (;;) {
    if (current === stop) return null;

    for (const marker of PROJECT_MARKERS) {
      const markerPath = path.join(current, marker);
      // Markers may be a directory (`.git`) or a file (`package.json`).
      if ((await isDirectory(markerPath)) || (await isFile(markerPath))) return current;
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
