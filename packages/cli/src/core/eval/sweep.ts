/**
 * Threshold and quota sweep.
 *
 * Tuning by sweep rather than by feel, so the defaults in `thresholds.ts` and `shortlist.ts`
 * can be traced back to a measurement. The grid is deliberately small: each point costs
 * `fixtures × repeat` API calls, and a wide grid on a noisy objective mostly measures noise.
 */

import { DEFAULT_QUOTA_GROUPS, type QuotaGroup } from "../retrieval/shortlist.js";
import type { CatalogEntry } from "../catalog/types.js";
import type { ResolvedFixture } from "./fixtures.js";
import { evaluateGate, type GateCriteria, type GateResult } from "./report.js";
import { runEval, type EvalConfig, type EvalReport, type RouteCaller } from "./run.js";

export interface SweepGrid {
  noneThreshold: number[];
  /** Values for the skill group's limit. Other groups keep their default. */
  skillQuota: number[];
  /** Values for `runnerUpThreshold`, swept only when supplied. */
  runnerUpThreshold?: number[];
  /** Values for the winner-probability floor, swept only when supplied. */
  minWinnerProbability?: number[];
}

export const DEFAULT_SWEEP_GRID: SweepGrid = {
  noneThreshold: [0.3, 0.4, 0.5, 0.6, 0.7],
  skillQuota: [4, 6, 8],
};

export interface SweepPoint {
  noneThreshold: number;
  skillQuota: number;
  minWinnerProbability: number;
  runnerUpThreshold?: number;
  report: EvalReport;
  gate: GateResult;
  /** One-line summary for a comparison table. */
  summary: {
    recallAtK: number;
    top1Accuracy: number;
    noneRecall: number;
    noneF1: number;
    agreementRate: number;
    p95: number;
    passed: boolean;
  };
}

export interface SweepOptions {
  fixtures: readonly ResolvedFixture[];
  /** Eval corpus, forwarded to every point. Without it a live sweep has nothing to rank. */
  entries: readonly CatalogEntry[];
  /** Quota groups per skill-quota value, so a caller can vary more than the skill group. */
  quotaGroupsFor: (skillQuota: number) => readonly QuotaGroup[];
  baseConfig: EvalConfig;
  repeat: number;
  grid?: SweepGrid;
  callRoute?: RouteCaller;
  criteria?: GateCriteria;
  /**
   * Called after each completed grid point.
   *
   * A sweep is many minutes of API calls; without a progress signal a long run is
   * indistinguishable from a hung one.
   */
  onPoint?: (point: SweepPoint, done: number, total: number) => void;
  /** Stop after the first point that passes. */
  stopOnPass?: boolean;
}

/** Replace the skill group's limit, keeping every other group as configured. */
export function quotaGroupsWithSkillLimit(
  skillQuota: number,
  base: readonly QuotaGroup[] = DEFAULT_QUOTA_GROUPS,
): QuotaGroup[] {
  return base.map((group) =>
    group.kinds.includes("skill") ? { kinds: group.kinds, limit: skillQuota } : { ...group },
  );
}

/**
 * Run the grid and return one point per configuration, best first.
 *
 * Ordering is by gate result, then by top-1 accuracy, then by p95 latency. A configuration
 * that passes the gate is always preferred over one that does not, regardless of how good
 * its other numbers look.
 */
export async function runSweep(options: SweepOptions): Promise<SweepPoint[]> {
  const grid = options.grid ?? DEFAULT_SWEEP_GRID;
  const points: SweepPoint[] = [];
  const runnerUpValues = grid.runnerUpThreshold ?? [undefined];
  const winnerFloorValues = grid.minWinnerProbability ?? [
    options.baseConfig.thresholds.minWinnerProbability ?? 0.25,
  ];
  const total =
    grid.noneThreshold.length * grid.skillQuota.length * runnerUpValues.length * winnerFloorValues.length;

  let done = 0;
  let passed: SweepPoint | undefined;

  for (const skillQuota of grid.skillQuota) {
    for (const noneThreshold of grid.noneThreshold) {
      for (const minWinnerProbability of winnerFloorValues) {
        for (const runnerUpThreshold of runnerUpValues) {
          if (options.stopOnPass === true && passed !== undefined) break;

          const thresholds = {
            ...options.baseConfig.thresholds,
            noneThreshold,
            minWinnerProbability,
            ...(runnerUpThreshold === undefined ? {} : { runnerUpThreshold }),
          };

          const report = await runEval({
            fixtures: options.fixtures,
            entries: options.entries,
            repeat: options.repeat,
            config: {
              ...options.baseConfig,
              thresholds,
              quotaGroups: options.quotaGroupsFor(skillQuota),
            },
            ...(options.callRoute === undefined ? {} : { callRoute: options.callRoute }),
          });

          const gate = evaluateGate(report, options.criteria);
          const point: SweepPoint = {
            noneThreshold,
            skillQuota,
            minWinnerProbability,
            ...(runnerUpThreshold === undefined ? {} : { runnerUpThreshold }),
            report,
            gate,
            summary: {
              recallAtK: report.aggregate.retrieval.recallAtK,
              top1Accuracy: report.aggregate.decision.top1Accuracy,
              noneRecall: report.aggregate.decision.noneRecall,
              noneF1: report.aggregate.decision.noneF1,
              agreementRate: report.aggregate.stability.agreementRate,
              p95: report.aggregate.latency.p95,
              passed: gate.passed,
            },
          };

          points.push(point);
          done += 1;
          options.onPoint?.(point, done, total);
          if (gate.passed) passed ??= point;
        }
      }
    }
  }

  points.sort((a, b) => {
    if (a.summary.passed !== b.summary.passed) return a.summary.passed ? -1 : 1;
    if (a.summary.top1Accuracy !== b.summary.top1Accuracy) {
      return b.summary.top1Accuracy - a.summary.top1Accuracy;
    }
    return a.summary.p95 - b.summary.p95;
  });

  return points;
}

/** Render the sweep as a Markdown table, including the configurations that lost. */
export function renderSweep(report: {
  grid: SweepGrid;
  repeat: number;
  points: readonly SweepPoint[];
  corpusFingerprint: string;
  ranAt: string;
}): string {
  const lines: string[] = [];
  lines.push("# Threshold sweep", "");
  lines.push(`- Repeats per point: ${report.repeat}`);
  lines.push(`- Corpus fingerprint: \`${report.corpusFingerprint}\``);
  lines.push(`- Ran at: ${report.ranAt}`);
  lines.push(`- Points: ${report.points.length}`);
  lines.push("");

  lines.push(
    "| noneThreshold | skillQuota | minWinnerP | recall@K | top1 | noneRecall | noneF1 | agreement | p95 | gate |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const point of report.points) {
    lines.push(
      `| ${point.noneThreshold} | ${point.skillQuota} | ${point.minWinnerProbability} | ${point.summary.recallAtK.toFixed(3)} | ` +
        `${point.summary.top1Accuracy.toFixed(3)} | ${point.summary.noneRecall.toFixed(3)} | ` +
        `${point.summary.noneF1.toFixed(3)} | ${point.summary.agreementRate.toFixed(3)} | ` +
        `${point.summary.p95}ms | ${point.summary.passed ? "pass" : "fail"} |`,
    );
  }
  lines.push("");

  const best = report.points[0];
  if (best !== undefined) {
    lines.push("## Selected configuration", "");
    lines.push(
      `noneThreshold ${best.noneThreshold}, skill quota ${best.skillQuota}, minWinnerProbability ${best.minWinnerProbability}`,
    );
    lines.push("");
    const failing = best.gate.checks.filter((check) => !check.ok);
    if (failing.length > 0) {
      lines.push("Criteria still failing on the best configuration:");
      lines.push("");
      for (const check of failing) {
        lines.push(`- ${check.name}: ${check.display}, required ${check.comparison === "min" ? "≥" : "≤"} ${check.required}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}
