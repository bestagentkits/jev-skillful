/**
 * Recording and replaying TypeSafe responses, so the eval gate can run without a key.
 *
 * Replay works by substituting a fake `fetch` underneath the real router rather than by
 * reimplementing the routing decision. Everything the metrics measure — the shortlist, the
 * thresholds, the abstention logic — is then the production code path, and a replay run
 * cannot silently drift from a live one.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { SystemOneResponse } from "../jev/types.js";

export interface RecordedFixture {
  /**
   * The exact `state.task` string the request carried, used as the replay lookup key.
   *
   * Matching on the transmitted task rather than on the fixture prompt keeps replay correct
   * when the prompt was truncated, or withheld entirely by `--no-prompt-upload`.
   */
  task: string;
  responses: SystemOneResponse[];
}

export type ReplayFile = Record<string, RecordedFixture>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Read the `state.task` value out of a request body without assuming it is well formed. */
export function taskFromBody(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const state = (parsed as { state?: unknown }).state;
    if (typeof state !== "object" || state === null) return undefined;
    const task = (state as { task?: unknown }).task;
    return typeof task === "string" ? task : undefined;
  } catch {
    return undefined;
  }
}

export class Recorder {
  private readonly byFixture = new Map<string, RecordedFixture>();

  /**
   * Wrap a fetch so successful System One responses are captured.
   *
   * One recording per distinct task, appended across repeats. `repeat` identical tasks give
   * `repeat` recorded responses, which is what lets replay reproduce the stability metric
   * instead of reporting a meaningless agreement of 1.0.
   */
  fetch(inner: typeof fetch, fixtureIdFor: (task: string) => string | undefined): typeof fetch {
    return (async (url: string | URL, init?: RequestInit) => {
      const response = await inner(url, init);

      if (response.ok) {
        const task = taskFromBody(String(init?.body ?? ""));
        const fixtureId = task === undefined ? undefined : fixtureIdFor(task);
        if (task !== undefined && fixtureId !== undefined) {
          // The router reads the body once; cloning first leaves the original usable.
          const clone = response.clone();
          try {
            const parsed = (await clone.json()) as SystemOneResponse;
            const existing = this.byFixture.get(fixtureId);
            if (existing === undefined) {
              this.byFixture.set(fixtureId, { task, responses: [parsed] });
            } else {
              existing.responses.push(parsed);
            }
          } catch {
            // An unparseable body is not worth failing a recording run over; the live run
            // already reports the malformed response as a degraded result.
          }
        }
      }

      return response;
    }) as typeof fetch;
  }

  get recorded(): ReplayFile {
    return Object.fromEntries(this.byFixture);
  }

  get count(): number {
    let total = 0;
    for (const entry of this.byFixture.values()) total += entry.responses.length;
    return total;
  }
}

export function saveReplay(filePath: string, replay: ReplayFile): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(replay, null, 2)}\n`, "utf8");
}

export function loadReplay(filePath: string): ReplayFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new Error(`${filePath}: replay file is not readable JSON (${reason})`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${filePath}: replay file must be a JSON object`);
  }
  return parsed as ReplayFile;
}

export interface ReplayFetchResult {
  fetch: typeof fetch;
  /** Tasks that were requested but had no recording. Non-empty means the replay is incomplete. */
  missing: string[];
}

/**
 * Build a `fetch` that answers from a recording.
 *
 * Recorded responses are consumed in order per task and then cycled. Cycling rather than
 * failing is deliberate: a recording made with `--repeat 1` can still serve a `--repeat 5`
 * run on a limited fixture set, at the cost of reporting perfect stability, which is a
 * limitation to state rather than to hide.
 */
export function makeReplayFetch(replay: ReplayFile): ReplayFetchResult {
  const cursors = new Map<string, number>();
  const missing: string[] = [];

  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    const task = taskFromBody(body);

    const entry = task === undefined
      ? undefined
      : Object.values(replay).find((candidate) => candidate.task === task);

    if (entry === undefined || entry.responses.length === 0) {
      if (task !== undefined && !missing.includes(task)) missing.push(task);
      // An empty answers map makes the router return a `malformed` degraded result, which is
      // the honest outcome for a missing recording and shows up in the report.
      return jsonResponse({ model: "replay", answers: {} });
    }

    const cursor = cursors.get(entry.task) ?? 0;
    const response = entry.responses[cursor % entry.responses.length];
    cursors.set(entry.task, cursor + 1);
    return jsonResponse(response ?? { model: "replay", answers: {} });
  }) as typeof fetch;

  return { fetch: fetchImpl, missing };
}
