/**
 * Gate evaluation and report rendering.
 *
 * The gate is the decision point of the whole plan. Phase 4 does not start unless the
 * router clears these numbers on a held-out fixture set, and a failure is a legitimate,
 * useful outcome that gets written down with the configurations that were tried — not a
 * problem to be smoothed over by adjusting the fixture set.
 */

import type { EvalReport } from "./run.js";

export interface GateCriteria {
  recallAtK: number;
  top1Accuracy: number;
  noneRecall: number;
  noneF1: number;
  agreementRate: number;
  /** p95 latency must be at or below this. */
  p95LatencyMs: number;
}

export const DEFAULT_GATE: GateCriteria = {
  recallAtK: 0.9,
  top1Accuracy: 0.8,
  noneRecall: 0.9,
  noneF1: 0.8,
  agreementRate: 0.9,
  p95LatencyMs: 1500,
};

export interface GateCheck {
  name: string;
  actual: number;
  required: number;
  comparison: "min" | "max";
  ok: boolean;
  /** Formatted for display, so the report and the terminal agree. */
  display: string;
}

export interface GateResult {
  passed: boolean;
  checks: GateCheck[];
}

function formatRatio(value: number): string {
  return value.toFixed(3);
}

/** Compare a report against the gate criteria. */
export function evaluateGate(report: EvalReport, criteria: GateCriteria = DEFAULT_GATE): GateResult {
  const { retrieval, decision, stability, latency } = report.aggregate;

  const checks: GateCheck[] = [
    {
      name: "recall@K",
      actual: retrieval.recallAtK,
      required: criteria.recallAtK,
      comparison: "min",
      ok: retrieval.recallAtK >= criteria.recallAtK,
      display: formatRatio(retrieval.recallAtK),
    },
    {
      name: "top1Accuracy",
      actual: decision.top1Accuracy,
      required: criteria.top1Accuracy,
      comparison: "min",
      ok: decision.top1Accuracy >= criteria.top1Accuracy,
      display: formatRatio(decision.top1Accuracy),
    },
    {
      name: "noneRecall",
      actual: decision.noneRecall,
      required: criteria.noneRecall,
      comparison: "min",
      ok: decision.noneRecall >= criteria.noneRecall,
      display: formatRatio(decision.noneRecall),
    },
    {
      name: "noneF1",
      actual: decision.noneF1,
      required: criteria.noneF1,
      comparison: "min",
      ok: decision.noneF1 >= criteria.noneF1,
      display: formatRatio(decision.noneF1),
    },
    {
      name: "agreementRate",
      actual: stability.agreementRate,
      required: criteria.agreementRate,
      comparison: "min",
      ok: stability.agreementRate >= criteria.agreementRate,
      display: formatRatio(stability.agreementRate),
    },
    {
      name: "p95 latency",
      actual: latency.p95,
      required: criteria.p95LatencyMs,
      comparison: "max",
      ok: latency.p95 <= criteria.p95LatencyMs,
      display: `${latency.p95}ms`,
    },
  ];

  return { passed: checks.every((check) => check.ok), checks };
}

export interface ReportProvenance {
  /** Fixture file the run used. */
  fixtureSource: string;
  /** `live` or `replay`. */
  mode: string;
  /** Catalog fingerprint of the corpus snapshot. */
  corpusFingerprint: string;
  corpusCapturedAt: string;
  /** ISO timestamp of the run. */
  ranAt: string;
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = `| ${headers.join(" | ")} |`;
  const rule = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
  return [head, rule, body].join("\n");
}

/**
 * Render the report as Markdown.
 *
 * Sample sizes and the group breakdown are printed unconditionally. An aggregate accuracy
 * with no sample size behind it invites a reader to over-trust a number produced by an
 * afternoon of fixture writing.
 */
export function renderMarkdown(
  report: EvalReport,
  gate: GateResult,
  provenance: ReportProvenance,
): string {
  const { retrieval, decision, stability, latency } = report.aggregate;
  const lines: string[] = [];

  lines.push("# Router evaluation", "");
  lines.push(`- Gate: **${gate.passed ? "PASSED" : "FAILED"}**`);
  lines.push(`- Fixtures: ${report.meta.fixtureCount}, repeats: ${report.meta.repeat}, total runs: ${report.meta.totalRuns}`);
  lines.push(`- Mode: ${provenance.mode}`);
  lines.push(`- Fixture set: \`${provenance.fixtureSource}\``);
  lines.push(`- Corpus fingerprint: \`${provenance.corpusFingerprint}\``);
  lines.push(`- Corpus captured: ${provenance.corpusCapturedAt}`);
  lines.push(`- Ran at: ${provenance.ranAt}`);
  lines.push("");

  lines.push("## Gate criteria", "");
  lines.push(
    table(
      ["Metric", "Required", "Actual", "Result"],
      gate.checks.map((check) => [
        check.name,
        `${check.comparison === "min" ? "≥" : "≤"} ${check.required}`,
        check.display,
        check.ok ? "pass" : "**FAIL**",
      ]),
    ),
  );
  lines.push("");

  lines.push("## Fixture coverage", "");
  lines.push(
    table(
      ["Group", "Fixtures"],
      Object.entries(report.meta.groupCounts).map(([group, count]) => [group, String(count)]),
    ),
  );
  lines.push("");

  lines.push("## Retrieval (layer 1)", "");
  lines.push(`Scored over ${retrieval.sampleSize} non-abstain runs; abstain fixtures have no gold to retrieve.`);
  lines.push("");
  lines.push(
    table(
      ["Metric", "Value"],
      [
        ["recall@K", formatRatio(retrieval.recallAtK)],
        ["MRR", formatRatio(retrieval.mrr)],
        ["gold in shortlist (per item)", formatRatio(retrieval.goldInShortlistRate)],
      ],
    ),
  );
  lines.push("");

  const kindRows = Object.entries(report.byKind);
  if (kindRows.length > 0) {
    lines.push("By gold kind:");
    lines.push("");
    lines.push(
      table(
        ["Kind", "Runs", "Recall", "MRR"],
        kindRows.map(([kind, metrics]) => [
          kind,
          String(metrics.sampleSize),
          formatRatio(metrics.recall),
          formatRatio(metrics.mrr),
        ]),
      ),
    );
    lines.push("");
  }

  lines.push("## Decision (layer 2)", "");
  lines.push(
    table(
      ["Metric", "Value"],
      [
        ["top1Accuracy", formatRatio(decision.top1Accuracy)],
        ["abstentionCorrectness", formatRatio(decision.abstentionCorrectness)],
        ["nonePrecision", formatRatio(decision.nonePrecision)],
        ["noneRecall", formatRatio(decision.noneRecall)],
        ["noneF1", formatRatio(decision.noneF1)],
        ["degraded rate", formatRatio(decision.degradedRate)],
      ],
    ),
  );
  lines.push("");
  lines.push(
    `Counts: expected abstain ${decision.counts.expectAbstain}, actually abstained ${decision.counts.actuallyAbstained}, ` +
      `true abstain ${decision.counts.trueAbstain}, correct pick ${decision.counts.correctPick}, ` +
      `wrong pick ${decision.counts.wrongPick}, missed abstain ${decision.counts.missedAbstain}.`,
  );
  lines.push("");

  lines.push("## Per group", "");
  lines.push(
    table(
      ["Group", "Runs", "Recall@K", "top1", "noneRecall", "noneF1", "p95"],
      Object.entries(report.byGroup).map(([group, metrics]) => [
        group,
        String(metrics.decision.sampleSize),
        formatRatio(metrics.retrieval.recallAtK),
        formatRatio(metrics.decision.top1Accuracy),
        formatRatio(metrics.decision.noneRecall),
        formatRatio(metrics.decision.noneF1),
        `${metrics.latency.p95}ms`,
      ]),
    ),
  );
  lines.push("");

  lines.push("## Stability", "");
  lines.push(`${stability.unanimous} of ${stability.fixtureCount} fixtures gave the same decision on all ${stability.repeat} repeats.`);
  lines.push("");
  if (stability.unstable.length > 0) {
    lines.push("Fixtures that changed their answer:");
    lines.push("");
    lines.push(
      table(
        ["Fixture", "Decisions across repeats"],
        stability.unstable.map((entry) => [entry.fixtureId, entry.signatures.join(" · ")]),
      ),
    );
    lines.push("");
  }

  lines.push("## Latency", "");
  lines.push(
    table(
      ["Metric", "Value"],
      [
        ["p50", `${latency.p50}ms`],
        ["p95", `${latency.p95}ms`],
        ["p99", `${latency.p99}ms`],
        ["mean", `${Math.round(latency.mean)}ms`],
        ["max", `${latency.max}ms`],
        ["over budget", `${latency.overBudget} of ${latency.samples} (budget ${latency.budgetMs}ms)`],
        ["mean tokens in", String(Math.round(latency.meanTokensIn))],
        ["mean tokens out", String(Math.round(latency.meanTokensOut))],
      ],
    ),
  );
  lines.push("");

  lines.push("## Configuration", "");
  lines.push("```json");
  lines.push(JSON.stringify(report.meta.config, null, 2));
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}

/** Render the gate result for a terminal. */
export function renderGateText(gate: GateResult): string {
  const lines = gate.checks.map((check) => {
    const required = `${check.comparison === "min" ? "≥" : "≤"} ${check.required}`;
    return `  ${check.ok ? "pass" : "FAIL"}  ${check.name.padEnd(16)} ${check.display.padStart(8)}  (required ${required})`;
  });
  lines.push("");
  lines.push(gate.passed ? "GATE PASSED" : "GATE FAILED");
  return lines.join("\n");
}
