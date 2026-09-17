/**
 * Reading telemetry events.
 *
 * The reader is written to survive a log that is being appended to while it reads, and a log that
 * contains a half-written line from an interrupted process. Both are normal rather than
 * exceptional: the hook appends on every prompt, so a report run almost always overlaps a write.
 *
 * Two decisions follow from that. **A bad line is skipped, never fatal**, because a report that
 * refuses to run because of one corrupt line is useless exactly when it is needed. And **the
 * number of skipped lines is reported**, because silently dropping data and then presenting
 * statistics computed from what remains is how a measurement system lies without anybody intending
 * it to.
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { isTelemetryEvent, type TelemetryEvent } from "./events.js";

export interface ReadResult {
  events: TelemetryEvent[];
  /** Lines that could not be parsed or failed validation. Reported, never hidden. */
  skipped: number;
  /** Total lines examined, including skipped ones. */
  totalLines: number;
  /** Non-fatal problems, one line each. */
  warnings: string[];
}

export interface ReadOptions {
  /** Reads at most this many bytes from the end of the file. 0 or undefined reads everything. */
  maxBytes?: number;
}

/**
 * Read and parse a log file.
 *
 * Never throws. A missing file is an empty result, because a user who has never routed anything
 * should see an empty report rather than an error.
 */
export function readEvents(filePath: string, options: ReadOptions = {}): ReadResult {
  const warnings: string[] = [];
  let raw: string;

  try {
    const size = statSync(filePath).size;
    const maxBytes = options.maxBytes ?? 0;

    if (maxBytes > 0 && size > maxBytes) {
      // Read only the tail. The first line of a tail read is almost certainly partial, so it is
      // dropped rather than parsed; counting it as "skipped" would overstate corruption.
      const fd = openSync(filePath, "r");
      try {
        const buffer = Buffer.allocUnsafe(maxBytes);
        const bytesRead = readSync(fd, buffer, 0, maxBytes, size - maxBytes);
        const text = buffer.subarray(0, bytesRead).toString("utf8");
        const firstNewline = text.indexOf("\n");
        raw = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
        warnings.push(
          `Read the last ${Math.round(maxBytes / 1024)}KB of a ${Math.round(size / 1024)}KB log.`,
        );
      } finally {
        closeSync(fd);
      }
    } else {
      raw = readFileSync(filePath, "utf8");
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") warnings.push(`Could not read ${filePath}: ${code ?? "unknown"}`);
    return { events: [], skipped: 0, totalLines: 0, warnings };
  }

  const events: TelemetryEvent[] = [];
  let skipped = 0;
  let totalLines = 0;

  for (const line of raw.split("\n")) {
    // A trailing newline produces one empty final element, which is not corruption.
    if (line.length === 0) continue;
    totalLines += 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }

    if (!isTelemetryEvent(parsed)) {
      skipped += 1;
      continue;
    }
    events.push(parsed);
  }

  return { events, skipped, totalLines, warnings };
}

/** Only the `route` events, which is what most analyses want. */
export function routeEvents(result: ReadResult): Extract<TelemetryEvent, { kind: "route" }>[] {
  return result.events.filter(
    (event): event is Extract<TelemetryEvent, { kind: "route" }> => event.kind === "route",
  );
}

/** Only the `capability-used` events. */
export function usageEvents(
  result: ReadResult,
): Extract<TelemetryEvent, { kind: "capability-used" }>[] {
  return result.events.filter(
    (event): event is Extract<TelemetryEvent, { kind: "capability-used" }> =>
      event.kind === "capability-used",
  );
}
