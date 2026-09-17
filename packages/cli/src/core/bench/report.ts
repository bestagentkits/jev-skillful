/**
 * Pilot pre-screening, and assembling the outcome report.
 *
 * **The pilot exists because a real repository does not guarantee that any capability applies to a
 * task.** Without it, a task the agent solves on its own contributes a pass to both arms and dilutes
 * the effect toward zero, and a task that is impossible contributes a failure to both. Either way the
 * measured effect shrinks toward nothing for reasons that have nothing to do with injection, and the
 * result becomes uninterpretable: "the capability did not help" and "the capability was irrelevant"
 * look identical.
 *
 * So the control arm runs first, on its own, and every candidate is classified:
 *
 * - control passed → the task was not capability-bound. Moved to `neutral` or excluded, and recorded.
 * - control failed → kept as a candidate, because a failing control leaves room for the treatment to
 *   show an effect.
 * - control failed with an environment error → excluded, with the error, because a build failure is
 *   not a task outcome.
 *
 * Every exclusion is written down with its reason. A suite whose exclusions are invisible cannot be
 * assessed: a reader cannot tell a carefully filtered 20 tasks from a 40-task suite that quietly lost
 * half its sample.
 */

import { computeQuadrants, renderQuadrants } from "./analysis/quadrants.js";
import { computeMde } from "./analysis/power.js";
import { assertReportable, computeRae, type TaskOutcome } from "./analysis/rae.js";
import { conclude, mcnemar, pairedBootstrapCi, reduceRunsToBinary, type TaskRuns } from "./analysis/significance.js";
import { renderTaxonomy, summariseTaxonomy, type HarmCase } from "./analysis/taxonomy.js";
import type { ArmResult, TaskRunResult } from "./runner.js";
import type { BenchTask, TaskGroup } from "./task.js";

// ---------------------------------------------------------------------------
// Screening
// ---------------------------------------------------------------------------

export type ScreenVerdict =
  | "capability-bound"
  | "not-capability-bound"
  | "environment-error";

export interface ScreenResult {
  taskId: string;
  repo: string;
  verdict: ScreenVerdict;
  reason: string;
  group: TaskGroup;
}

/**
 * Classify one candidate from its control-arm result.
 *
 * A control pass means the task is not capability-bound: the agent solved it without help, so there
 * is nothing for the treatment to add and nothing to measure.
 */
export function screenCandidate(task: BenchTask, control: ArmResult): ScreenResult {
  if (control.environmentError !== null) {
    return {
      taskId: task.id,
      repo: task.repo,
      verdict: "environment-error",
      reason: control.environmentError,
      group: task.group,
    };
  }

  if (control.success) {
    return {
      taskId: task.id,
      repo: task.repo,
      verdict: "not-capability-bound",
      reason:
        "The control arm solved this task without injection, so it carries no evidence about the treatment.",
      group: "neutral",
    };
  }

  return {
    taskId: task.id,
    repo: task.repo,
    verdict: "capability-bound",
    reason: `Control arm failed ${control.failToPassTotal - control.failToPassPassing} of ${control.failToPassTotal} target test(s), leaving room for the treatment to show an effect.`,
    group: task.group,
  };
}

export interface ExclusionRecord {
  taskId: string;
  repo: string;
  reason: string;
  detail: string;
}

export interface ScreeningOutcome {
  keep: BenchTask[];
  neutral: BenchTask[];
  excluded: ExclusionRecord[];
}

/** Apply screening results to the candidate list. */
export function applyScreening(candidates: readonly BenchTask[], results: readonly ScreenResult[]): ScreeningOutcome {
  const byId = new Map(results.map((result) => [result.taskId, result] as const));
  const outcome: ScreeningOutcome = { keep: [], neutral: [], excluded: [] };

  for (const task of candidates) {
    const result = byId.get(task.id);
    if (result === undefined) {
      outcome.excluded.push({
        taskId: task.id,
        repo: task.repo,
        reason: "not-screened",
        detail: "The pilot did not reach this task.",
      });
      continue;
    }

    switch (result.verdict) {
      case "capability-bound":
        outcome.keep.push(task);
        break;
      case "not-capability-bound":
        outcome.neutral.push({ ...task, group: "neutral" });
        break;
      default:
        outcome.excluded.push({
          taskId: task.id,
          repo: task.repo,
          reason: "environment-error",
          detail: result.reason,
        });
    }
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

export interface BenchOutcomeReport {
  conclusion: "proven" | "not-proven" | "harmful";
  rae: number;
  aggregateLift: number;
  ci: { low: number; high: number; level: number; iterations: number; seed: number };
  b: number;
  c: number;
  n: number;
  nInvoked: number;
  repeat: number;
  mde: number | null;
  mdeNote: string;
  mcnemar: { statistic: number; df: number; pValue: number; discordant: number; note: string };
  tasks: {
    total: number;
    invokedSubset: number;
    both: number;
    onlyControl: number;
    onlyTreatment: number;
    neither: number;
  };
  perTask: {
    taskId: string;
    repo: string;
    group: string;
    injected: boolean;
    controlSuccess: boolean;
    treatmentSuccess: boolean;
    controlRuns: boolean[];
    treatmentRuns: boolean[];
  }[];
  /** Tasks where injection made the outcome worse, for dashboard section 6. */
  harmful: { task: string; reason: string }[];
  taxonomy: { total: number; byReason: Record<string, number>; unstable: number };
  excluded: ExclusionRecord[];
  /** Environment problems that stopped the suite, so an incomplete run is visible as incomplete. */
  blockers: string[];
  note: string;
}

export interface BuildReportInput {
  runs: readonly TaskRunResult[];
  excluded: readonly ExclusionRecord[];
  repeat: number;
  seed?: number;
  /** Effects below this size are not worth detecting, for the MDE interpretation. */
  expectedEffect?: number;
  blockers?: readonly string[];
  harmReasons?: readonly HarmCase[];
}

/**
 * Assemble the outcome report.
 *
 * The required fields are all present by construction, and `assertReportable` refuses an impossible
 * combination. There is no code path that produces an aggregate lift without an RAE beside it, which
 * is the reporting rule the plan sets and the one a summary is most likely to violate.
 */
export function buildOutcomeReport(input: BuildReportInput): BenchOutcomeReport {
  const seed = input.seed ?? 20260917;

  // Group runs by task, so repeated runs collapse to one observation per task before anything is
  // computed. Doing this here rather than trusting the caller is what keeps repeats from inflating
  // the sample size.
  const byTask = new Map<string, TaskRunResult[]>();
  for (const run of input.runs) {
    const list = byTask.get(run.taskId) ?? [];
    list.push(run);
    byTask.set(run.taskId, list);
  }

  const taskRuns: TaskRuns[] = [];
  const perTask: BenchOutcomeReport["perTask"] = [];

  for (const [taskId, runs] of byTask) {
    const first = runs[0];
    if (first === undefined) continue;

    const injected = runs.some((run) => run.treatment.injectionObserved);
    const controlRuns = runs.map((run) => run.control.success);
    const treatmentRuns = runs.map((run) => run.treatment.success);

    taskRuns.push({ taskId, injected, controlSuccesses: controlRuns, treatmentSuccesses: treatmentRuns });

    const reduced = reduceRunsToBinary([
      { taskId, injected, controlSuccesses: controlRuns, treatmentSuccesses: treatmentRuns },
    ])[0];

    perTask.push({
      taskId,
      repo: first.repo,
      group: first.group,
      injected,
      controlSuccess: reduced?.controlSuccess ?? false,
      treatmentSuccess: reduced?.treatmentSuccess ?? false,
      controlRuns,
      treatmentRuns,
    });
  }

  const outcomes: TaskOutcome[] = perTask.map((task) => ({
    taskId: task.taskId,
    injected: task.injected,
    controlSuccess: task.controlSuccess,
    treatmentSuccess: task.treatmentSuccess,
  }));

  const raeResult = computeRae(outcomes);
  assertReportable(raeResult);

  const quadrants = computeQuadrants(outcomes);

  const invokedDifferences = outcomes
    .filter((outcome) => outcome.injected)
    .map((outcome) => (outcome.treatmentSuccess ? 1 : 0) - (outcome.controlSuccess ? 1 : 0));

  const ci = pairedBootstrapCi(invokedDifferences, { seed });
  const mcnemarResult = mcnemar(raeResult.b, raeResult.c);

  const mde = computeMde({
    n: raeResult.nInvoked,
    discordant: raeResult.b + raeResult.c,
  });

  const verdict = conclude({ rae: raeResult.rae, interval: ci, mde: mde.mde });

  const harmReasons = input.harmReasons ?? [];
  const taxonomy = summariseTaxonomy(harmReasons);

  const harmful = perTask
    .filter((task) => task.controlSuccess && !task.treatmentSuccess && task.injected)
    .map((task) => ({
      task: task.taskId,
      reason:
        harmReasons.find((item) => item.taskId === task.taskId)?.reason ??
        "Not yet classified. Requires reading the run.",
    }));

  const blockers = [...(input.blockers ?? [])];

  return {
    conclusion: verdict.conclusion,
    rae: raeResult.rae,
    aggregateLift: raeResult.aggregateLift,
    ci: { ...ci, seed },
    b: raeResult.b,
    c: raeResult.c,
    n: raeResult.n,
    nInvoked: raeResult.nInvoked,
    repeat: input.repeat,
    mde: mde.mde,
    mdeNote: mde.note,
    mcnemar: {
      statistic: mcnemarResult.statistic,
      df: mcnemarResult.df,
      pValue: mcnemarResult.pValue,
      discordant: mcnemarResult.discordant,
      note: mcnemarResult.note,
    },
    tasks: {
      total: raeResult.n,
      invokedSubset: raeResult.nInvoked,
      both: quadrants.bothPassed,
      onlyControl: quadrants.harmed,
      onlyTreatment: quadrants.rescued,
      neither: quadrants.bothFailed,
    },
    perTask,
    harmful,
    taxonomy: { total: taxonomy.total, byReason: taxonomy.byReason, unstable: taxonomy.unstable },
    excluded: [...input.excluded],
    blockers,
    note: verdict.reason,
  };
}

/** Render the report as Markdown, with every required field present. */
export function renderOutcomeReport(report: BenchOutcomeReport): string {
  const lines: string[] = [];

  lines.push("# Outcome benchmark");
  lines.push("");
  lines.push(`**Conclusion: \`${report.conclusion}\`**`);
  lines.push("");
  lines.push(report.note);
  lines.push("");

  if (report.blockers.length > 0) {
    lines.push("## Why this run is incomplete");
    lines.push("");
    for (const blocker of report.blockers) lines.push(`- ${blocker}`);
    lines.push("");
  }

  lines.push("## Result");
  lines.push("");
  lines.push("| | Value |");
  lines.push("|---|---|");
  lines.push(`| Tasks (n) | ${report.n} |`);
  lines.push(`| Injected (nInvoked) | ${report.nInvoked} |`);
  lines.push(`| Repeats (R) | ${report.repeat} |`);
  lines.push(`| **RAE** | **${report.rae.toFixed(3)}** |`);
  lines.push(`| Aggregate lift | ${report.aggregateLift.toFixed(3)} |`);
  lines.push(`| b (control pass, treatment fail) | ${report.b} |`);
  lines.push(`| c (control fail, treatment pass) | ${report.c} |`);
  lines.push(
    `| ${Math.round(report.ci.level * 100)}% CI | ${report.ci.low.toFixed(3)} to ${report.ci.high.toFixed(3)} |`,
  );
  lines.push(`| Resamples (seed ${report.ci.seed}) | ${report.ci.iterations} |`);
  lines.push(
    `| McNemar | χ²=${report.mcnemar.statistic.toFixed(3)}, df=${report.mcnemar.df}, p=${report.mcnemar.pValue.toFixed(4)} |`,
  );
  lines.push(`| **MDE** | ${report.mde === null ? "not estimable" : report.mde.toFixed(3)} |`);
  lines.push("");

  if (report.mcnemar.note.length > 0) {
    lines.push(`> ${report.mcnemar.note}`);
    lines.push("");
  }

  lines.push("## Outcomes by arm");
  lines.push("");
  lines.push(
    renderQuadrants({
      bothPassed: report.tasks.both,
      rescued: report.tasks.onlyTreatment,
      harmed: report.tasks.onlyControl,
      bothFailed: report.tasks.neither,
      notInvoked: report.n - report.nInvoked,
    }),
  );
  lines.push("");

  lines.push("## Power");
  lines.push("");
  lines.push(report.mdeNote);
  lines.push("");

  if (report.perTask.length > 0) {
    lines.push("## Per task");
    lines.push("");
    lines.push("| Task | Group | Injected | Control | Treatment |");
    lines.push("|---|---|---|---|---|");
    for (const task of report.perTask) {
      lines.push(
        `| ${task.taskId} | ${task.group} | ${task.injected ? "yes" : "no"} | ${task.controlSuccess ? "pass" : "fail"} | ${task.treatmentSuccess ? "pass" : "fail"} |`,
      );
    }
    lines.push("");
  }

  if (report.taxonomy.total > 0) {
    lines.push("## Classification of harmed tasks");
    lines.push("");
    lines.push(renderTaxonomy(report.taxonomy));
    lines.push("");
  }

  if (report.excluded.length > 0) {
    lines.push("## Excluded at the pilot stage");
    lines.push("");
    lines.push(`${report.excluded.length} candidate task(s) were removed before the suite ran.`);
    lines.push("");
    lines.push("| Task | Reason | Detail |");
    lines.push("|---|---|---|");
    for (const item of report.excluded) {
      lines.push(`| ${item.taskId} | ${item.reason} | ${item.detail} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
