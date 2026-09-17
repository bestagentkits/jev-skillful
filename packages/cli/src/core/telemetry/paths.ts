/**
 * Where telemetry lives on each platform.
 *
 * The state directory is the right home for this and not the cache directory, because the log is
 * not disposable: deleting the cache costs one round trip, and deleting the log destroys the only
 * record of what the router decided. That distinction is why the two are in different places.
 *
 * Every function takes the environment and home directory as arguments rather than reading them
 * directly, so tests exercise all three platforms without touching the real filesystem.
 */

import path from "node:path";

export const APP_DIR_NAME = "skillful";
export const EVENTS_FILE_NAME = "events.jsonl";

export interface PathContext {
  homeDir: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Overrides platform detection. Tests use it to cover all three branches. */
  platform?: NodeJS.Platform;
}

/**
 * The per-user state directory.
 *
 * Follows the platform convention rather than inventing one: `XDG_STATE_HOME` on Linux,
 * `~/Library/Application Support` on macOS, `%LOCALAPPDATA%` on Windows. A user who has set
 * `XDG_STATE_HOME` gets it honoured, because a tool that ignores the XDG variables is a tool that
 * puts files where the user said not to.
 */
export function stateDir(ctx: PathContext): string {
  const platform = ctx.platform ?? process.platform;

  const xdg = ctx.env["XDG_STATE_HOME"];
  if (typeof xdg === "string" && xdg.trim().length > 0) {
    return path.join(xdg, APP_DIR_NAME);
  }

  if (platform === "win32") {
    const localAppData = ctx.env["LOCALAPPDATA"];
    if (typeof localAppData === "string" && localAppData.trim().length > 0) {
      return path.join(localAppData, APP_DIR_NAME);
    }
    return path.join(ctx.homeDir, "AppData", "Local", APP_DIR_NAME);
  }

  if (platform === "darwin") {
    return path.join(ctx.homeDir, "Library", "Application Support", APP_DIR_NAME);
  }

  return path.join(ctx.homeDir, ".local", "state", APP_DIR_NAME);
}

/** The append-only event log. */
export function eventsPath(ctx: PathContext): string {
  return path.join(stateDir(ctx), EVENTS_FILE_NAME);
}

/** Rotated logs are `<events>.1`, `<events>.2`, and so on. */
export function rotatedEventsPath(ctx: PathContext, index: number): string {
  return `${eventsPath(ctx)}.${index}`;
}

/** Where a generated report is written when the user does not name a path. */
export function defaultReportPath(ctx: PathContext): string {
  return path.join(stateDir(ctx), "report.html");
}
