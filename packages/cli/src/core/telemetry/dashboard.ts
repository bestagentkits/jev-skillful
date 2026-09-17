/**
 * The self-contained HTML dashboard.
 *
 * Six sections, and the last two are the reason this file exists at all.
 *
 * Sections one to four describe what happened locally: how often something was suggested, whether
 * the router agreed with itself, how slow it was, and whether agents took the suggestion. Those are
 * useful and they are also the easy part.
 *
 * Sections five and six describe whether any of it helped. A dashboard that shows only positive
 * numbers is not evidence, and the paper this project is built on specifically warns that an
 * aggregate lift can be positive while the effect on the very tasks that received the treatment is
 * negative. So section six exists to list the tasks where injection made things *worse*, and
 * sections five and six refuse to invent anything: with no benchmark results they render the
 * absence, because a plausible-looking placeholder number is worse than a blank.
 *
 * The output has no external reference of any kind. No stylesheet link, no script tag, no font, no
 * image. It opens from disk, offline, which is the only environment it is guaranteed to be read in.
 */

import { readFileSync } from "node:fs";
import type { TelemetryEvent } from "./events.js";
import { barChart, confusionTable, escapeHtml, formatNumber, formatRate, histogram, latencyBuckets } from "./charts.js";
import type { TelemetrySummary } from "./aggregate.js";
import { ACCEPTANCE_WINDOW_MS } from "./aggregate.js";
import type { GateResult } from "../eval/report.js";
import { redactText } from "../redact.js";

/** Outcome benchmark results, as phase 7 writes them. Absent until that phase has run. */
export interface BenchOutcome {
  conclusion: "proven" | "not-proven" | "harmful";
  rae: number;
  aggregateLift: number;
  ci: { low: number; high: number; level: number };
  tasks: {
    total: number;
    invokedSubset: number;
    both: number;
    onlyControl: number;
    onlyTreatment: number;
    neither: number;
  };
  /** Tasks where injection made the outcome worse, with the reason where known. */
  harmful: { task: string; reason: string }[];
  mde: number | null;
  /** The smallest detectable effect, or null when the sample was too small to estimate one. */
  note?: string;
}

export interface DashboardInput {
  summary: TelemetrySummary;
  events: readonly TelemetryEvent[];
  /** The eval gate result, when `skillful eval` has been run. */
  gate?: GateResult | null;
  /** Benchmark results, when phase 7 has been run. */
  bench?: BenchOutcome | null;
  generatedAt: Date;
  homeDir: string;
  /** Include prompt text. Off by default; prompts are the one thing a user may not want stored. */
  includePrompts?: boolean;
  /** The prompt text per hash, only used when `includePrompts` is set. */
  promptsByHash?: Readonly<Record<string, string>>;
}

/** Render the whole report. */
export function renderDashboard(input: DashboardInput): string {
  const { summary } = input;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Skillful report</title>
<style>${STYLES}</style>
</head>
<body>
<main>
  <header>
    <h1>Skillful report</h1>
    <p class="meta">
      Generated ${escapeHtml(input.generatedAt.toISOString())}
      · ${summary.overview.totalPrompts} prompts
      · ${summary.totalLines} log lines${summary.skippedLines > 0 ? `, ${summary.skippedLines} unreadable` : ""}
      ${summary.firstTs === null ? "" : `· ${escapeHtml(summary.firstTs)} to ${escapeHtml(summary.lastTs ?? "")}`}
    </p>
  </header>

  ${sectionOverview(summary)}
  ${sectionRoutingQuality(input)}
  ${sectionOperational(summary, input.events)}
  ${sectionAdoption(summary)}
  ${sectionBench(input.bench ?? null)}
  ${sectionHarm(input.bench ?? null)}
  ${sectionFailures(summary, input)}
</main>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// 1. Overview
// ---------------------------------------------------------------------------

function sectionOverview(summary: TelemetrySummary): string {
  const o = summary.overview;
  return `<section>
  <h2>1. Overview</h2>
  <div class="cards">
    ${card("Prompts routed", String(o.totalPrompts))}
    ${card("Something injected", `${formatRate(o.injectionRate)}`, `${o.injected}`)}
    ${card("Correctly abstained", `${formatRate(o.abstentionRate)}`, `${o.skipped}`)}
    ${card("Degraded", `${formatRate(o.degradeRate)}`, `${o.degraded}`, o.degraded > 0)}
    ${card("Cache hit", `${formatRate(o.cacheHitRate)}`)}
    ${card("Sessions", String(o.sessions))}
  </div>
  <p class="note">
    Injection rate is not a quality measure. A router that injects rarely is not better than one that
    injects often; abstention and injection are both correct depending on the prompt.
  </p>
</section>`;
}

// ---------------------------------------------------------------------------
// 2. Routing quality
// ---------------------------------------------------------------------------

function sectionRoutingQuality(input: DashboardInput): string {
  const gate = input.gate;
  if (gate === null || gate === undefined) {
    return `<section>
  <h2>2. Routing quality</h2>
  <p class="empty">Not measured yet. Run <code>skillful eval --replay bench/replay/routing.json</code>.</p>
</section>`;
  }

  const rows = gate.checks
    .map(
      (check) => `<tr>
      <td>${escapeHtml(check.name)}</td>
      <td class="num">${formatNumber(check.actual)}</td>
      <td class="num">${formatNumber(check.required)}</td>
      <td class="${check.ok ? "good" : "bad"}">${check.ok ? "pass" : "FAIL"}</td>
    </tr>`,
    )
    .join("");

  const failed = gate.checks.filter((check) => !check.ok);

  return `<section>
  <h2>2. Routing quality</h2>
  <table>
    <thead><tr><th>Metric</th><th class="num">Actual</th><th class="num">Target</th><th>Result</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${
    failed.length === 0
      ? `<p class="note">Every criterion is met.</p>`
      : `<p class="warn-note">${failed.length} of ${gate.checks.length} criteria are not met: ${failed.map((check) => escapeHtml(check.name)).join(", ")}. The targets are the plan's, and they are reported as they stand rather than restated to match the result.</p>`
  }
</section>`;
}

// ---------------------------------------------------------------------------
// 3. Operations
// ---------------------------------------------------------------------------

function sectionOperational(summary: TelemetrySummary, events: readonly TelemetryEvent[]): string {
  const o = summary.operational;
  const latencies = events
    .filter((event) => event.kind === "route")
    .map((event) => (event as { latencyMs: number }).latencyMs)
    .filter((value) => Number.isFinite(value));

  const degradeRows = o.degradeCauses
    .map((entry) => `<tr><td>${escapeHtml(entry.reason)}</td><td class="num">${entry.count}</td></tr>`)
    .join("");
  const skipRows = o.skipReasons
    .map((entry) => `<tr><td>${escapeHtml(entry.reason)}</td><td class="num">${entry.count}</td></tr>`)
    .join("");

  return `<section>
  <h2>3. Operations</h2>
  <div class="cards">
    ${card("p50", `${Math.round(o.p50)}ms`)}
    ${card("p95", `${Math.round(o.p95)}ms`)}
    ${card("p99", `${Math.round(o.p99)}ms`)}
    ${card("Mean tokens in", o.meanTokensIn === null ? "–" : String(Math.round(o.meanTokensIn)))}
    ${card("Mean tokens out", o.meanTokensOut === null ? "–" : String(Math.round(o.meanTokensOut)))}
  </div>
  <h3>Latency distribution</h3>
  ${histogram(latencyBuckets(latencies))}
  <div class="split">
    <div>
      <h3>Degraded by cause</h3>
      ${degradeRows === "" ? `<p class="empty">None.</p>` : `<table><tbody>${degradeRows}</tbody></table>`}
    </div>
    <div>
      <h3>Abstained by reason</h3>
      ${skipRows === "" ? `<p class="empty">None.</p>` : `<table><tbody>${skipRows}</tbody></table>`}
    </div>
  </div>
</section>`;
}

// ---------------------------------------------------------------------------
// 4. Adoption
// ---------------------------------------------------------------------------

function sectionAdoption(summary: TelemetrySummary): string {
  const a = summary.adoption;
  const top = summary.candidates.slice(0, 12);

  return `<section>
  <h2>4. Adoption</h2>
  <div class="cards">
    ${card("Suggestions", String(a.suggestions))}
    ${card("Accepted", formatRate(a.acceptanceRate))}
    ${card("Uses not matched", String(a.unmatchedUses))}
    ${card("Uses unobservable", String(a.unobserved))}
  </div>
  ${
    top.length === 0
      ? `<p class="empty">No suggestions recorded.</p>`
      : `<h3>Most suggested capabilities</h3>${barChart(
          top.map((item) => ({ label: item.id, value: item.suggested })),
        )}
        <table>
          <thead><tr><th>Capability</th><th class="num">Suggested</th><th class="num">Accepted</th></tr></thead>
          <tbody>${top
            .map(
              (item) =>
                `<tr><td>${escapeHtml(item.id)}</td><td class="num">${item.suggested}</td><td class="num">${item.accepted}</td></tr>`,
            )
            .join("")}</tbody>
        </table>`
  }
  <p class="note">
    Inference, not observation. A use is counted as an acceptance when the same session was suggested
    that capability within ${Math.round(ACCEPTANCE_WINDOW_MS / 60000)} minutes. A session that used a
    capability for its own reasons therefore looks like an acceptance. This is why the two causes are
    separable at all — "the router chose wrong" and "the agent ignored a good suggestion" need
    different fixes — but the number is an upper bound, not a measurement.
  </p>
</section>`;
}

// ---------------------------------------------------------------------------
// 5. Outcome benchmark
// ---------------------------------------------------------------------------

function sectionBench(bench: BenchOutcome | null): string {
  if (bench === null) {
    return `<section>
  <h2>5. Outcome benchmark</h2>
  <p class="empty">
    Not run. Whether injection makes an agent complete a task better is measured by comparing
    outcomes on the same task with and without it, on a real repository, in a frozen container.
    Until that runs, this report makes no claim about task outcomes.
  </p>
</section>`;
  }

  const conclusionClass =
    bench.conclusion === "proven" ? "good" : bench.conclusion === "harmful" ? "bad" : "neutral";

  return `<section>
  <h2>5. Outcome benchmark</h2>
  <p class="conclusion ${conclusionClass}">${escapeHtml(bench.conclusion)}</p>
  <div class="cards">
    ${card("RAE", formatNumber(bench.rae))}
    ${card("Aggregate lift", formatNumber(bench.aggregateLift))}
    ${card("CI", `${formatNumber(bench.ci.low)} to ${formatNumber(bench.ci.high)}`)}
    ${card("Tasks", `${bench.tasks.invokedSubset} / ${bench.tasks.total}`)}
    ${card("MDE", bench.mde === null ? "not estimable" : formatNumber(bench.mde))}
  </div>
  <p class="note">
    ${escapeHtml(conclusionLabel(bench.conclusion))}
    RAE is the difference in outcome on the same task between the two arms, computed only over the
    ${bench.tasks.invokedSubset} tasks where injection actually happened. Aggregate lift over all
    tasks is shown separately because it includes tasks the treatment never touched.
  </p>
  <h3>Outcomes by arm</h3>
  ${confusionTable({
    both: bench.tasks.both,
    onlyControl: bench.tasks.onlyControl,
    onlyTreatment: bench.tasks.onlyTreatment,
    neither: bench.tasks.neither,
  })}
  <p class="note">
    Injected passed / control failed: ${bench.tasks.onlyTreatment}. Injected failed / control passed:
    ${bench.tasks.onlyControl}. The second number is the one an average hides.
  </p>
  ${bench.note === undefined ? "" : `<p class="note">${escapeHtml(bench.note)}</p>`}
</section>`;
}

function conclusionLabel(conclusion: BenchOutcome["conclusion"]): string {
  switch (conclusion) {
    case "proven":
      return "RAE is positive and the confidence interval excludes zero.";
    case "harmful":
      return "RAE is negative: injection made outcomes worse on the tasks it reached.";
    default:
      return "The confidence interval contains zero, so no effect is demonstrated at this sample size.";
  }
}

// ---------------------------------------------------------------------------
// 6. Honest failures
// ---------------------------------------------------------------------------

function sectionHarm(bench: BenchOutcome | null): string {
  if (bench === null) {
    return `<section>
  <h2>6. Where injection did harm</h2>
  <p class="empty">
    Not run. This section lists the tasks where injection made the outcome worse. It is empty because
    nothing has been measured, not because nothing was found.
  </p>
</section>`;
  }

  if (bench.harmful.length === 0) {
    return `<section>
  <h2>6. Where injection did harm</h2>
  <p class="note">No task in the invoked subset did worse with injection. At ${bench.tasks.invokedSubset} tasks this is a result about this sample, not a guarantee.</p>
</section>`;
  }

  return `<section>
  <h2>6. Where injection did harm</h2>
  <p class="warn-note">
    ${bench.harmful.length} task${bench.harmful.length === 1 ? "" : "s"} did worse with injection.
    This section exists because an aggregate lift can be positive while the effect on the tasks that
    received the treatment is negative, and a report that hides that is not evidence.
  </p>
  <table>
    <thead><tr><th>Task</th><th>Reason</th></tr></thead>
    <tbody>${bench.harmful
      .map(
        (item) =>
          `<tr><td>${escapeHtml(item.task)}</td><td>${escapeHtml(item.reason)}</td></tr>`,
      )
      .join("")}</tbody>
  </table>
</section>`;
}

// ---------------------------------------------------------------------------
// Data-quality appendix
// ---------------------------------------------------------------------------

function sectionFailures(summary: TelemetrySummary, input: DashboardInput): string {
  const problems: string[] = [];

  if (summary.skippedLines > 0) {
    problems.push(
      `${summary.skippedLines} of ${summary.totalLines} log lines could not be parsed and were excluded. Every number above is computed from what remained.`,
    );
  }
  if (summary.adoption.unobserved > 0) {
    problems.push(
      `${summary.adoption.unobserved} capability uses came from a runtime that could not report what was used, and are recorded as unobserved rather than guessed.`,
    );
  }
  if (summary.overview.degraded > 0) {
    problems.push(
      `${summary.overview.degraded} routes degraded, so the router did not decide for those prompts.`,
    );
  }

  return `<section>
  <h2>Appendix: what is missing from these numbers</h2>
  ${
    problems.length === 0
      ? `<p class="note">No data-quality problems were detected in this log.</p>`
      : `<ul>${problems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join("")}</ul>`
  }
  <p class="note">
    ${input.includePrompts === true ? "This report includes prompt text, which was requested explicitly." : "This report contains no prompt text. Only a hash and a character count per prompt."}
    Capability names are included, and a capability name can identify a private project. Read this
    file before sharing it.
  </p>
  <p class="note">
    Redaction applied: home directories are collapsed and absolute paths, credential-shaped strings
    and environment values are removed.
  </p>
</section>`;
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function card(label: string, value: string, sub?: string, warn = false): string {
  return `<div class="card${warn ? " card-warn" : ""}">
    <div class="card-label">${escapeHtml(label)}</div>
    <div class="card-value">${escapeHtml(value)}</div>
    ${sub === undefined ? "" : `<div class="card-sub">${escapeHtml(sub)}</div>`}
  </div>`;
}

const STYLES = `
:root {
  --bg: #ffffff; --fg: #16181d; --muted: #5c6270; --line: #e3e6ec;
  --accent: #2b5bd7; --warn: #c2410c; --good: #15803d; --code-bg: #f5f6f9;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e1013; --fg: #e8eaef; --muted: #9aa2b1; --line: #262b33;
    --accent: #7aa2f7; --warn: #fb923c; --good: #4ade80; --code-bg: #161a20;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
main { max-width: 60rem; margin: 0 auto; padding: 2.5rem 1.25rem 5rem; }
header h1 { margin: 0 0 .25rem; font-size: 1.6rem; letter-spacing: -.02em; }
.meta { color: var(--muted); font-size: .875rem; margin: 0 0 2rem; }
section { margin: 2.5rem 0; padding-top: 1.5rem; border-top: 1px solid var(--line); }
h2 { font-size: 1.15rem; margin: 0 0 1rem; }
h3 { font-size: .95rem; margin: 1.5rem 0 .5rem; color: var(--muted); }
table { width: 100%; border-collapse: collapse; font-size: .9rem; margin: .5rem 0; }
th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 600; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.good { color: var(--good); font-weight: 600; }
.bad { color: var(--warn); font-weight: 600; }
.cards { display: flex; flex-wrap: wrap; gap: .75rem; margin: .5rem 0 1rem; }
.card { flex: 1 1 9rem; border: 1px solid var(--line); border-radius: 8px; padding: .7rem .85rem; }
.card-warn { border-color: var(--warn); }
.card-label { color: var(--muted); font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }
.card-value { font-size: 1.35rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.card-sub { color: var(--muted); font-size: .8rem; }
.note { color: var(--muted); font-size: .875rem; }
.warn-note { color: var(--warn); font-size: .875rem; font-weight: 500; }
.empty { color: var(--muted); font-style: italic; }
.conclusion { font-size: 1.1rem; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
.conclusion.good { color: var(--good); }
.conclusion.bad { color: var(--warn); }
.conclusion.neutral { color: var(--muted); }
.split { display: flex; flex-wrap: wrap; gap: 2rem; }
.split > div { flex: 1 1 16rem; }
.chart-label { font-size: 11px; fill: var(--fg); }
.chart-value { font-size: 11px; fill: var(--muted); font-variant-numeric: tabular-nums; }
.chart-axis { font-size: 10px; fill: var(--muted); }
.confusion th { text-align: left; }
.confusion td { text-align: center; font-variant-numeric: tabular-nums; }
code { background: var(--code-bg); padding: .1em .3em; border-radius: 3px; font-size: .9em;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
ul { padding-left: 1.25rem; }
`;

/** Read benchmark results, or null when phase 7 has not run. */
export function loadBenchOutcome(filePath: string): BenchOutcome | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Partial<BenchOutcome>;
    // A partial file is treated as absent rather than rendered with blanks, because a benchmark
    // result with missing counts is not a weaker result, it is an invalid one.
    if (typeof candidate.rae !== "number" || candidate.tasks === undefined) return null;
    if (candidate.conclusion === undefined) return null;
    return candidate as BenchOutcome;
  } catch {
    return null;
  }
}

/** Redact a rendered report. Applied to the final HTML so nothing can bypass it. */
export function redactReport(html: string, homeDir: string): string {
  if (homeDir.length <= 1) return html;
  return redactText(html, { homeDir });
}
