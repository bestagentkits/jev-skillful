/**
 * Tests for the telemetry layer.
 *
 * The emphasis is on the failure modes, because this code runs inside a user's agent session on a
 * two-second budget and against a log that is being appended to while it is read. The tests that
 * matter are: a write never throws, a bad line never fails a report, a degraded result is still
 * recorded, and the report never invents a benchmark number.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACCEPTANCE_WINDOW_MS, matchUsage, summarise } from "./aggregate.js";
import { barChart, confusionTable, escapeHtml, formatRate, latencyBuckets } from "./charts.js";
import { loadBenchOutcome, renderDashboard } from "./dashboard.js";
import { MAX_LINE_BYTES, SCHEMA_VERSION, isTelemetryEvent, type RouteEvent, type TelemetryEvent } from "./events.js";
import { eventsPath, stateDir } from "./paths.js";
import { readEvents, routeEvents, usageEvents } from "./reader.js";
import { maintain, rotatedPaths } from "./retention.js";
import { buildCapabilityUsedEvent, buildRouteEvent, isTelemetryDisabled, logSize, writeEvent } from "./writer.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "skillful-tel-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

describe("paths", () => {
  it("follows the platform convention", () => {
    const ctx = { homeDir: "/home/u", env: {} };
    expect(stateDir({ ...ctx, platform: "darwin" })).toBe(
      "/home/u/Library/Application Support/skillful",
    );
    expect(stateDir({ ...ctx, platform: "linux" })).toBe("/home/u/.local/state/skillful");
    expect(stateDir({ ...ctx, platform: "win32", env: { LOCALAPPDATA: "C:\\AppData" } })).toBe(
      "C:\\AppData/skillful",
    );
  });

  it("honours XDG_STATE_HOME when it is set", () => {
    // A tool that ignores the XDG variables puts files where the user said not to.
    expect(stateDir({ homeDir: "/home/u", env: { XDG_STATE_HOME: "/custom/state" } })).toBe(
      "/custom/state/skillful",
    );
    // An empty value must not be treated as set.
    expect(stateDir({ homeDir: "/home/u", env: { XDG_STATE_HOME: "  " }, platform: "linux" })).toBe(
      "/home/u/.local/state/skillful",
    );
  });

  it("puts the log in the state directory, not the cache directory", () => {
    const file = eventsPath({ homeDir: "/home/u", env: {}, platform: "linux" });
    expect(file).toBe("/home/u/.local/state/skillful/events.jsonl");
    expect(file).not.toContain("cache");
  });
});

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

describe("events", () => {
  it("accepts a well-formed route event and rejects an incomplete one", () => {
    expect(
      isTelemetryEvent({
        v: 1,
        kind: "route",
        ts: "2026-09-17T09:00:00.000Z",
        runtime: "claude-code",
        sessionId: "s",
        promptHash: "abc",
        decision: "injected",
        latencyMs: 12,
        candidateIds: [],
      }),
    ).toBe(true);

    // Missing `decision` would contribute a wrong number to a rate rather than being noticed.
    expect(
      isTelemetryEvent({
        v: 1,
        kind: "route",
        ts: "2026-09-17T09:00:00.000Z",
        runtime: "claude-code",
        sessionId: "s",
        promptHash: "abc",
        latencyMs: 12,
        candidateIds: [],
      }),
    ).toBe(false);
  });

  it("rejects non-objects and unknown kinds", () => {
    expect(isTelemetryEvent(null)).toBe(false);
    expect(isTelemetryEvent([])).toBe(false);
    expect(isTelemetryEvent("route")).toBe(false);
    expect(isTelemetryEvent({ kind: "something-else", ts: "x", runtime: "y", sessionId: "z" })).toBe(false);
  });

  it("tolerates unknown extra fields, so a newer event does not break an older reader", () => {
    expect(
      isTelemetryEvent({
        v: SCHEMA_VERSION,
        kind: "capability-used",
        ts: "2026-09-17T09:00:00.000Z",
        runtime: "pi",
        sessionId: "s",
        capabilityId: "x",
        via: "tool-call",
        futureField: { nested: true },
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// writer
// ---------------------------------------------------------------------------

const ROUTE_RESULT = {
  decision: { kind: "injected" as const },
  shortlist: ["a", "b", "c"],
  ranking: [{ id: "a", noul: 0.9 }],
  primary: { id: "a", noneP: 0.01, confidence: 1, probability: 0.8 },
  latencyMs: 742.4,
  cacheHit: false,
  promptChars: 132,
  tokensIn: 1360,
  tokensOut: 140,
};

function buildEvent(overrides: { now?: Date } = {}): RouteEvent {
  return buildRouteEvent({
    result: ROUTE_RESULT,
    runtime: "claude-code",
    sessionId: "s1",
    promptHash: "hash1",
    catalogFingerprint: "fp1",
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  });
}

describe("writer", () => {
  it("appends one line per event and never throws", () => {
    const file = path.join(makeDir(), "nested", "events.jsonl");

    expect(writeEvent(buildEvent(), { filePath: file })).toBe(true);
    expect(writeEvent(buildEvent(), { filePath: file })).toBe(true);

    expect(readEvents(file).events).toHaveLength(2);
  });

  it("returns false rather than throwing when the path cannot be written", () => {
    // A path under a file, not a directory: mkdirSync will fail with ENOTDIR.
    const dir = makeDir();
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "not a directory", "utf8");

    expect(() => writeEvent(buildEvent(), { filePath: path.join(blocker, "events.jsonl") })).not.toThrow();
    expect(writeEvent(buildEvent(), { filePath: path.join(blocker, "events.jsonl") })).toBe(false);
  });

  it("is a no-op when disabled", () => {
    const file = path.join(makeDir(), "events.jsonl");
    expect(writeEvent(buildEvent(), { filePath: file, enabled: false })).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it("drops a line that would exceed the bound rather than writing it", () => {
    const file = path.join(makeDir(), "events.jsonl");
    const huge = buildRouteEvent({
      result: { ...ROUTE_RESULT, shortlist: Array.from({ length: 40 }, (_, i) => `id-${i}-${"x".repeat(2000)}`) },
      runtime: "cli",
      sessionId: "s",
      promptHash: "h",
      catalogFingerprint: "f",
    });

    const written = writeEvent(huge, { filePath: file, maxLineBytes: 1024 });
    expect(written).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it("bounds the candidate and ranking lists so one event cannot grow without limit", () => {
    const event = buildRouteEvent({
      result: {
        ...ROUTE_RESULT,
        shortlist: Array.from({ length: 500 }, (_, i) => `id-${i}`),
        ranking: Array.from({ length: 500 }, (_, i) => ({ id: `id-${i}`, noul: 0.5 })),
      },
      runtime: "cli",
      sessionId: "s",
      promptHash: "h",
      catalogFingerprint: "f",
    });

    expect(event.candidateIds.length).toBeLessThanOrEqual(40);
    expect(event.ranking.length).toBeLessThanOrEqual(20);
    expect(Buffer.byteLength(JSON.stringify(event), "utf8")).toBeLessThan(MAX_LINE_BYTES);
  });

  it("records the degraded reason, so a failure is analysable rather than just counted", () => {
    const event = buildRouteEvent({
      result: { ...ROUTE_RESULT, decision: { kind: "degraded", reason: "timeout" } },
      runtime: "cli",
      sessionId: "s",
      promptHash: "h",
      catalogFingerprint: "f",
    });

    expect(event.decision).toBe("degraded");
    expect(event.error).toBe("timeout");
    // A degraded event is still recorded: an outage is data, not noise.
    expect(event.primary).toBeNull();
  });

  it("never records prompt text, only a hash and a length", () => {
    const event = buildEvent();
    const serialised = JSON.stringify(event);
    expect(serialised).not.toContain("prompt\":");
    expect(event.promptHash).toBe("hash1");
    expect(event.promptChars).toBe(132);
  });

  it("writes the log with owner-only permissions", () => {
    const file = path.join(makeDir(), "events.jsonl");
    writeEvent(buildEvent(), { filePath: file });
    // The mode check is POSIX-only; Windows reports different bits.
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("recognises the disable switch", () => {
    expect(isTelemetryDisabled({ SKILLFUL_TELEMETRY: "0" })).toBe(true);
    expect(isTelemetryDisabled({ SKILLFUL_TELEMETRY: "false" })).toBe(true);
    expect(isTelemetryDisabled({ SKILLFUL_TELEMETRY: "1" })).toBe(false);
    expect(isTelemetryDisabled({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reader
// ---------------------------------------------------------------------------

describe("reader", () => {
  it("skips a corrupt line, keeps the good ones, and reports how many were skipped", () => {
    const file = path.join(makeDir(), "events.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify(buildEvent()),
        "{ this is not json",
        JSON.stringify({ kind: "route" }), // valid JSON, invalid event
        JSON.stringify(buildEvent()),
        "",
      ].join("\n"),
      "utf8",
    );

    const result = readEvents(file);
    expect(result.events).toHaveLength(2);
    expect(result.skipped).toBe(2);
    expect(result.totalLines).toBe(4);
  });

  it("returns an empty result for a missing file rather than an error", () => {
    const result = readEvents(path.join(makeDir(), "absent.jsonl"));
    expect(result.events).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("reads only the tail when asked, and does not count a partial first line as corruption", () => {
    const file = path.join(makeDir(), "events.jsonl");
    for (let i = 0; i < 50; i += 1) writeEvent(buildEvent(), { filePath: file });

    const result = readEvents(file, { maxBytes: 800 });
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.length).toBeLessThan(50);
    expect(result.skipped).toBe(0);
    expect(result.warnings.join(" ")).toContain("last");
  });

  it("splits events by kind", () => {
    const file = path.join(makeDir(), "events.jsonl");
    writeEvent(buildEvent(), { filePath: file });
    writeEvent(
      buildCapabilityUsedEvent({ capabilityId: "a", runtime: "pi", sessionId: "s1", via: "tool-call" }),
      { filePath: file },
    );

    const result = readEvents(file);
    expect(routeEvents(result)).toHaveLength(1);
    expect(usageEvents(result)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// retention
// ---------------------------------------------------------------------------

describe("retention", () => {
  it("rotates once the log passes the size cap and keeps the configured number", () => {
    const file = path.join(makeDir(), "events.jsonl");
    writeEvent(buildEvent(), { filePath: file });

    const result = maintain({ filePath: file, maxBytes: 1, maxRotated: 2 });
    expect(result.rotated).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.1`)).toBe(true);

    // A second rotation shifts `.1` to `.2`.
    writeEvent(buildEvent(), { filePath: file });
    maintain({ filePath: file, maxBytes: 1, maxRotated: 2 });
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(`${file}.2`)).toBe(true);
  });

  it("does not rotate below the cap", () => {
    const file = path.join(makeDir(), "events.jsonl");
    writeEvent(buildEvent(), { filePath: file });
    expect(maintain({ filePath: file, maxBytes: 1024 * 1024 }).rotated).toBe(false);
    expect(existsSync(file)).toBe(true);
  });

  it("skips maintenance on most writes, so the hook does not pay for it per prompt", () => {
    const file = path.join(makeDir(), "events.jsonl");
    writeEvent(buildEvent(), { filePath: file });

    expect(maintain({ filePath: file, maxBytes: 1, writeCount: 1 }).rotated).toBe(false);
    expect(maintain({ filePath: file, maxBytes: 1, writeCount: 7 }).rotated).toBe(false);
    // The interval itself does run it.
    expect(maintain({ filePath: file, maxBytes: 1, writeCount: 200 }).rotated).toBe(true);
  });

  it("removes a rotated log past the retention window", () => {
    const dir = makeDir();
    const file = path.join(dir, "events.jsonl");
    const rotated = `${file}.1`;
    writeFileSync(rotated, "old\n", "utf8");

    // Backdate it well past the window.
    const longAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    utimesSync(rotated, longAgo, longAgo);

    writeEvent(buildEvent(), { filePath: file });
    const result = maintain({ filePath: file, retentionDays: 30, maxRotated: 3 });

    expect(result.removed).toContain(rotated);
    expect(existsSync(rotated)).toBe(false);
  });

  it("never throws on a read-only or missing path", () => {
    expect(() => maintain({ filePath: "/nonexistent-dir/events.jsonl" })).not.toThrow();
    expect(logSize("/nonexistent-dir/events.jsonl")).toBe(0);
    expect(rotatedPaths("/x/events.jsonl", 2)).toEqual(["/x/events.jsonl.1", "/x/events.jsonl.2"]);
  });
});

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

function routeAt(ts: string, decision: string, primary: string | null, latency: number): RouteEvent {
  return {
    v: 1,
    kind: "route",
    ts,
    runtime: "claude-code",
    sessionId: "s1",
    promptHash: "h",
    promptChars: 10,
    catalogFingerprint: "fp",
    candidateCount: 3,
    candidateIds: ["a"],
    primary,
    noneP: 0.1,
    confidence: 1,
    ranking: [],
    decision: decision as RouteEvent["decision"],
    reason: decision,
    latencyMs: latency,
    cacheHit: false,
    tokensIn: 100,
    tokensOut: 10,
    error: null,
  };
}

describe("aggregate", () => {
  it("computes the overview rates", () => {
    const events: TelemetryEvent[] = [
      routeAt("2026-09-17T09:00:00.000Z", "injected", "a", 100),
      routeAt("2026-09-17T09:01:00.000Z", "injected", "a", 200),
      routeAt("2026-09-17T09:02:00.000Z", "skipped", null, 50),
      routeAt("2026-09-17T09:03:00.000Z", "degraded", null, 30),
    ];

    const summary = summarise(events, { skippedLines: 0, totalLines: 4 });
    expect(summary.overview.totalPrompts).toBe(4);
    expect(summary.overview.injectionRate).toBe(0.5);
    expect(summary.overview.abstentionRate).toBe(0.25);
    expect(summary.overview.degradeRate).toBe(0.25);
    expect(summary.operational.p95).toBeGreaterThan(150);
  });

  it("reports an empty log without dividing by zero", () => {
    const summary = summarise([], { skippedLines: 0, totalLines: 0 });
    expect(summary.overview.totalPrompts).toBe(0);
    expect(summary.overview.injectionRate).toBe(0);
    expect(summary.adoption.acceptanceRate).toBeNull();
    expect(summary.candidates).toEqual([]);
  });

  it("counts a use as an acceptance only within the window and in the same session", () => {
    const route = routeAt("2026-09-17T09:00:00.000Z", "injected", "cap-a", 100);

    const withinWindow = buildCapabilityUsedEvent({
      capabilityId: "cap-a",
      runtime: "claude-code",
      sessionId: "s1",
      via: "skill-invoked",
      now: new Date(Date.parse("2026-09-17T09:05:00.000Z")),
    });
    const tooLate = buildCapabilityUsedEvent({
      capabilityId: "cap-a",
      runtime: "claude-code",
      sessionId: "s1",
      via: "skill-invoked",
      now: new Date(Date.parse("2026-09-17T09:00:00.000Z") + ACCEPTANCE_WINDOW_MS + 60_000),
    });
    const otherSession = buildCapabilityUsedEvent({
      capabilityId: "cap-a",
      runtime: "pi",
      sessionId: "other",
      via: "tool-call",
      now: new Date(Date.parse("2026-09-17T09:05:00.000Z")),
    });

    const within = matchUsage([route], [withinWindow]);
    expect(within.matched.size).toBe(1);

    expect(matchUsage([route], [tooLate]).matched.size).toBe(0);
    expect(matchUsage([route], [otherSession]).matched.size).toBe(0);
  });

  it("keeps unobservable uses out of the acceptance numerator", () => {
    const route = routeAt("2026-09-17T09:00:00.000Z", "injected", "cap-a", 100);
    const unobserved = buildCapabilityUsedEvent({
      capabilityId: "cap-a",
      runtime: "codex",
      sessionId: "s1",
      via: "unobserved",
      now: new Date(Date.parse("2026-09-17T09:01:00.000Z")),
    });

    const summary = summarise([route, unobserved], { skippedLines: 0, totalLines: 2 });
    expect(summary.adoption.unobserved).toBe(1);
    expect(summary.adoption.acceptanceRate).toBe(0);
  });

  it("tallies degrade causes separately rather than averaging them", () => {
    const events: TelemetryEvent[] = [
      { ...routeAt("2026-09-17T09:00:00.000Z", "degraded", null, 10), reason: "auth" },
      { ...routeAt("2026-09-17T09:01:00.000Z", "degraded", null, 10), reason: "auth" },
      { ...routeAt("2026-09-17T09:02:00.000Z", "degraded", null, 10), reason: "network" },
    ];

    const summary = summarise(events, { skippedLines: 0, totalLines: 3 });
    expect(summary.operational.degradeCauses[0]).toEqual({ reason: "auth", count: 2 });
    expect(summary.operational.degradeCauses[1]).toEqual({ reason: "network", count: 1 });
  });
});

// ---------------------------------------------------------------------------
// charts
// ---------------------------------------------------------------------------

describe("charts", () => {
  it("escapes untrusted text, because catalog data reaches the markup", () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
  });

  it("renders a bar chart and refuses to divide by an empty set", () => {
    expect(barChart([])).toContain("No data");
    const svg = barChart([{ label: "a", value: 5 }, { label: "b", value: 2 }]);
    expect(svg).toContain("<svg");
    expect(svg).toContain(">5<");
  });

  it("buckets latencies and handles a single repeated value", () => {
    expect(latencyBuckets([])).toEqual([]);
    expect(latencyBuckets([100, 100, 100])).toEqual([{ bucket: "100ms", count: 3 }]);
    expect(latencyBuckets([10, 20, 30, 40]).length).toBe(12);
  });

  it("renders the four-cell table with both directions of harm visible", () => {
    const table = confusionTable({ both: 5, onlyControl: 3, onlyTreatment: 2, neither: 1 });
    expect(table).toContain(">5<");
    // The bottom-left cell is injection hurting, and must be present in the markup.
    expect(table).toContain(">3<");
    expect(table).toContain(">2<");
  });

  it("formats a missing rate as an em dash rather than zero", () => {
    expect(formatRate(null)).toBe("–");
    expect(formatRate(0.5)).toBe("50.0%");
  });
});

// ---------------------------------------------------------------------------
// dashboard
// ---------------------------------------------------------------------------

describe("dashboard", () => {
  function render(bench: Parameters<typeof renderDashboard>[0]["bench"]): string {
    const events: TelemetryEvent[] = [routeAt("2026-09-17T09:00:00.000Z", "injected", "cap-a", 120)];
    return renderDashboard({
      summary: summarise(events, { skippedLines: 0, totalLines: 1 }),
      events,
      gate: null,
      bench,
      generatedAt: new Date("2026-09-17T10:00:00.000Z"),
      homeDir: "/Users/example",
    });
  }

  it("is self-contained: no external stylesheet, script, font or image", () => {
    const html = render(null);
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
    expect(html).toContain("<style>");
  });

  it("shows every section even with no data, and fabricates nothing", () => {
    const html = render(null);
    for (const heading of [
      "1. Overview",
      "2. Routing quality",
      "3. Operations",
      "4. Adoption",
      "5. Outcome benchmark",
      "6. Where injection did harm",
    ]) {
      expect(html).toContain(heading);
    }
    expect(html).toContain("Not run");
    // No number may appear where the benchmark result would go.
    expect(html).not.toContain("RAE</div>");
  });

  it("renders a benchmark result, including the cell where injection hurt", () => {
    const html = render({
      conclusion: "harmful",
      rae: -0.04,
      aggregateLift: 0.11,
      ci: { low: -0.08, high: -0.01, level: 0.95 },
      tasks: { total: 40, invokedSubset: 25, both: 10, onlyControl: 4, onlyTreatment: 6, neither: 5 },
      harmful: [{ task: "fix-flaky-test", reason: "the injected skill was for a different framework" }],
      mde: 0.03,
    });

    expect(html).toContain("harmful");
    expect(html).toContain("fix-flaky-test");
    expect(html).toContain("the injected skill was for a different framework");
    // The aggregate can be positive while the conditioned effect is negative; both are shown.
    expect(html).toContain("Aggregate lift");
  });

  it("reports skipped lines in the header, so the sample is visible", () => {
    const events: TelemetryEvent[] = [routeAt("2026-09-17T09:00:00.000Z", "injected", "cap-a", 120)];
    const html = renderDashboard({
      summary: summarise(events, { skippedLines: 7, totalLines: 8 }),
      events,
      gate: null,
      bench: null,
      generatedAt: new Date(),
      homeDir: "/Users/example",
    });

    expect(html).toContain("7 unreadable");
    expect(html).toContain("7 of 8 log lines could not be parsed");
  });

  it("treats a partial benchmark file as absent rather than rendering blanks", () => {
    const dir = makeDir();
    const file = path.join(dir, "bench-outcome.json");
    writeFileSync(file, JSON.stringify({ rae: 0.1 }), "utf8");
    expect(loadBenchOutcome(file)).toBeNull();
    expect(loadBenchOutcome(path.join(dir, "missing.json"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hook integration
// ---------------------------------------------------------------------------

describe("hook telemetry integration", () => {
  it("writes a route event when the hook runs, and none when disabled", async () => {
    const { runHook } = await import("../hooks/runner.js");
    const { mkdirSync: mk } = await import("node:fs");

    const home = makeDir();
    mk(path.join(home, ".pi", "agent"), { recursive: true });
    const telemetryPath = path.join(home, "tel.jsonl");

    const result = {
      decision: { kind: "injected" as const, primary: { id: "a", kind: "skill" as const, name: "a", description: "d", sourcePath: "/p", alternates: [] }, runnersUp: [], confidence: 1, noneP: 0 },
      shortlist: ["a"],
      shortlistDetail: [],
      ranking: [],
      latencyMs: 5,
      cacheHit: false,
      promptChars: 10,
      model: "jev-latest",
    };

    const deps = {
      homeDir: home,
      cwd: home,
      env: { TYPESAFE_API_KEY: "k" },
      telemetryPath,
      scan: async () => ({ entries: [], fingerprint: "fp", warnings: [] }),
      routeFn: (async () => result) as never,
    };

    await runHook({ prompt: "do a thing with the database", session_id: "s1" }, deps);
    expect(existsSync(telemetryPath)).toBe(true);
    const written = readEvents(telemetryPath);
    expect(written.events).toHaveLength(1);
    expect(written.events[0]?.kind).toBe("route");

    // With telemetry switched off, nothing more is written.
    await runHook(
      { prompt: "another prompt entirely", session_id: "s2" },
      { ...deps, env: { TYPESAFE_API_KEY: "k", SKILLFUL_TELEMETRY: "0" } },
    );
    expect(readEvents(telemetryPath).events).toHaveLength(1);
  });
});
