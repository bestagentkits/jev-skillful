/**
 * Classifying the tasks where injection made the outcome worse.
 *
 * The four-cell table tells you how many tasks were harmed. It does not tell you why, and the
 * reasons need different fixes:
 *
 * - **Wrong capability injected.** Retrieval put the wrong thing in the shortlist, or the decision
 *   picked wrongly from a correct shortlist. Fixed in the router.
 * - **Agent followed a bad suggestion.** The suggestion was defensible but the agent abandoned a
 *   correct approach to chase it. Fixed in how the injection is phrased, or by injecting less.
 * - **Context bloat.** The suggestion was fine and the agent ignored it, but something about the
 *   larger prompt changed the outcome. Fixed by injecting less, or not at all for that shape of task.
 * - **Noise.** The same task passes and fails run to run with identical inputs. This is not an
 *   effect at all, and counting it as harm inflates the harmful count.
 *
 * The last category is why the protocol re-runs discordant tasks three more times. An agent that is
 * nondeterministic on a task will produce a disagreement that looks exactly like harm, and the only
 * way to tell the difference is to see whether the outcome is stable.
 */

export const HARM_REASONS = [
  "wrong-capability",
  "agent-followed-bad-suggestion",
  "context-bloat",
  "nondeterminism",
  "unknown",
] as const;
export type HarmReason = (typeof HARM_REASONS)[number];

export interface HarmCase {
  taskId: string;
  reason: HarmReason;
  /** Free-text justification, written by whoever classified it. */
  evidence: string;
  /** Outcome of the re-runs used to check stability, most recent last. */
  reruns?: boolean[];
}

export interface TaxonomySummary {
  total: number;
  byReason: Record<HarmReason, number>;
  /** Cases whose re-runs were unstable, so the harm may be noise rather than an effect. */
  unstable: number;
}

export function summariseTaxonomy(cases: readonly HarmCase[]): TaxonomySummary {
  const byReason = Object.fromEntries(HARM_REASONS.map((reason) => [reason, 0])) as Record<
    HarmReason,
    number
  >;

  let unstable = 0;
  for (const item of cases) {
    byReason[item.reason] += 1;
    if (isUnstable(item)) unstable += 1;
  }

  return { total: cases.length, byReason, unstable };
}

/**
 * True when the re-runs disagree with each other.
 *
 * A task whose re-runs flip is not evidence of harm. It is reported separately rather than removed,
 * because removing it silently would understate the noise in the suite, and noise in the suite is
 * itself a finding.
 */
export function isUnstable(item: HarmCase): boolean {
  const reruns = item.reruns;
  if (reruns === undefined || reruns.length < 2) return false;
  return new Set(reruns).size > 1;
}

/** One line per reason, including the zeroes, so a missing category is visible rather than absent. */
export function renderTaxonomy(summary: TaxonomySummary): string {
  const lines = [
    `| Reason | Count |`,
    `|---|---|`,
    ...HARM_REASONS.map((reason) => `| ${reason} | ${summary.byReason[reason]} |`),
  ];

  if (summary.unstable > 0) {
    lines.push(
      "",
      `${summary.unstable} of ${summary.total} case(s) produced disagreeing results across re-runs, so they may be nondeterminism rather than harm. They are reported rather than removed.`,
    );
  }

  return lines.join("\n");
}
