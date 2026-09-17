/**
 * Compare the base and head eval reports for the PR gate.
 *
 * Kept in a file rather than inlined in the workflow because a heredoc inside YAML is hard to
 * read, hard to lint, and impossible to test. Run from the repository root after the base run has
 * written `before.json` and the head run has written `after.json`.
 *
 * Exits non-zero when a metric regresses, which is what makes the gate a gate.
 */

import { readFileSync, writeFileSync } from "node:fs";

/** Fields that are rates and are compared with a tolerance. */
const RATE_TOLERANCE = 0.01;

/** Milliseconds. p95 is noisy, so a small drift is not a regression. */
const LATENCY_TOLERANCE_MS = 100;

function summary(report) {
  return report.summary ?? report.aggregate ?? {};
}

function readReport(file) {
  try {
    return summary(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    console.error(`Could not read ${file}: ${error.message}`);
    process.exit(2);
  }
}

const before = readReport("before.json");
const after = readReport("after.json");

/** name, before, after, and which direction is worse. */
const metrics = [
  ["recall@K", before.recallAtK, after.recallAtK, "higher"],
  ["top1Accuracy", before.top1Accuracy, after.top1Accuracy, "higher"],
  ["noneRecall", before.noneRecall, after.noneRecall, "higher"],
  ["noneF1", before.noneF1, after.noneF1, "higher"],
  ["agreementRate", before.agreementRate, after.agreementRate, "higher"],
  ["p95LatencyMs", before.p95, after.p95, "lower"],
];

const lines = ["| Metric | Base | Head | Delta |", "|---|---|---|---|"];
let failed = false;
const missing = [];

for (const [name, base, head, direction] of metrics) {
  if (typeof base !== "number" || typeof head !== "number") {
    missing.push(name);
    continue;
  }

  const delta = head - base;
  const regressed =
    direction === "higher" ? delta < -RATE_TOLERANCE : delta > LATENCY_TOLERANCE_MS;

  if (regressed) failed = true;

  const mark = regressed ? " :x:" : delta === 0 ? "" : " :white_check_mark:";
  const sign = delta >= 0 ? "+" : "";
  lines.push(`| ${name} | ${base.toFixed(3)} | ${head.toFixed(3)} | ${sign}${delta.toFixed(3)}${mark} |`);
}

const body = [
  "### Eval gate",
  "",
  ...lines,
  "",
  failed
    ? "A metric regressed. If this change intentionally trades one metric for another, explain the trade in the PR body and a maintainer can override this check."
    : "No metric regressed.",
  "",
  "Recorded responses: no API key, no network, so this runs on pull requests from forks.",
  `Tolerances: ${RATE_TOLERANCE} on rates, ${LATENCY_TOLERANCE_MS}ms on p95.`,
];

if (missing.length > 0) {
  body.push("", `Metrics not present in both reports, skipped: ${missing.join(", ")}`);
}

const text = body.join("\n");
console.log(text);
writeFileSync("comment.md", text);

if (failed) {
  console.error("\nEval gate failed: a metric regressed.");
  process.exit(1);
}
