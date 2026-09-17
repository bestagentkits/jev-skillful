/**
 * The four-cell table.
 *
 * |                    | control passed | control failed |
 * |--------------------|----------------|----------------|
 * | injected passed    | both           | c: rescued     |
 * | injected failed    | b: harmed      | neither        |
 *
 * The bottom-left cell is the reason this table is a required deliverable rather than an appendix.
 * It is the count of tasks where injection made the outcome worse, and it is exactly the number a
 * mean over all tasks can hide: if injection rescues ten tasks and breaks eight, the average looks
 * like a small win and eight tasks got worse.
 *
 * Only tasks where injection happened are counted. A task the router abstained on cannot be evidence
 * about injection, so its disagreements are not attributed to the treatment.
 */

import type { TaskOutcome } from "./rae.js";

export interface Quadrants {
  /** Injection happened, both arms passed. */
  bothPassed: number;
  /** Injection happened, both arms failed. */
  bothFailed: number;
  /** Control passed, treatment failed. Injection hurt. */
  harmed: number;
  /** Control failed, treatment passed. Injection helped. */
  rescued: number;
  /** Tasks where the router abstained, so they carry no evidence about injection. */
  notInvoked: number;
}

export function computeQuadrants(outcomes: readonly TaskOutcome[]): Quadrants {
  const quadrants: Quadrants = {
    bothPassed: 0,
    bothFailed: 0,
    harmed: 0,
    rescued: 0,
    notInvoked: 0,
  };

  for (const outcome of outcomes) {
    if (!outcome.injected) {
      quadrants.notInvoked += 1;
      continue;
    }

    if (outcome.controlSuccess && outcome.treatmentSuccess) quadrants.bothPassed += 1;
    else if (!outcome.controlSuccess && !outcome.treatmentSuccess) quadrants.bothFailed += 1;
    else if (outcome.controlSuccess) quadrants.harmed += 1;
    else quadrants.rescued += 1;
  }

  return quadrants;
}

/** Interpret the table in words, including the case a summary would skip. */
export function describeQuadrants(quadrants: Quadrants): string {
  const invoked =
    quadrants.bothPassed + quadrants.bothFailed + quadrants.harmed + quadrants.rescued;

  if (invoked === 0) {
    return `No task received injection, so the table is empty (${quadrants.notInvoked} tasks abstained).`;
  }

  const parts = [
    `${quadrants.rescued} rescued`,
    `${quadrants.harmed} harmed`,
    `${quadrants.bothPassed} passed either way`,
    `${quadrants.bothFailed} failed either way`,
  ];

  if (quadrants.harmed > 0) {
    return `${parts.join(", ")}. ${quadrants.harmed} task${quadrants.harmed === 1 ? "" : "s"} did worse with injection, which an aggregate would not show.`;
  }

  return `${parts.join(", ")}. No task did worse with injection at this sample size.`;
}

/** Render the table as Markdown, for the report. */
export function renderQuadrants(quadrants: Quadrants): string {
  return [
    "|                    | Control passed | Control failed |",
    "|--------------------|----------------|----------------|",
    `| **Injected passed** | ${quadrants.bothPassed} | ${quadrants.rescued} |`,
    `| **Injected failed** | ${quadrants.harmed} | ${quadrants.bothFailed} |`,
    "",
    `${quadrants.notInvoked} task(s) were not injected and carry no evidence about the treatment.`,
  ].join("\n");
}
