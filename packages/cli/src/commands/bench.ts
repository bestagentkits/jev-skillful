/**
 * `skillful bench` — run the outcome benchmark.
 *
 * Four modes, and the pilot is deliberately the default path rather than an option: a suite that has
 * not been pre-screened produces an effect diluted by tasks that were never capability-bound, and the
 * dilution looks exactly like the capability not helping.
 *
 *   --probe     report which agent runtimes can actually complete a headless run
 *   --pilot     run the control arm only, and classify each candidate
 *   (default)   run both arms over the screened suite
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ADAPTERS, probeAdapter } from "../core/bench/agent-cli.js";
import { planImage, type DockerOptions } from "../core/bench/docker.js";
import {
  applyScreening,
  buildOutcomeReport,
  renderOutcomeReport,
  screenCandidate,
  type ExclusionRecord,
  type ScreenResult,
} from "../core/bench/report.js";
import { runTask, type TaskRunResult } from "../core/bench/runner.js";
import { assertUniqueIds, parseTasks, type BenchTask } from "../core/bench/task.js";
import type { CatalogRuntime } from "../core/catalog/types.js";

export interface BenchCommandOptions {
  suite?: string;
  /** Restrict to specific task ids. */
  tasks?: readonly string[];
  repeat: number;
  pilot: boolean;
  probe: boolean;
  runtime?: string;
  outDir?: string;
  maxTasks?: number;
  dryRun: boolean;
  json: boolean;
  homeDir?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

/** Resolve the runtime to use, preferring one that has been verified to work. */
function resolveRuntime(requested: string | undefined, available: CatalogRuntime[]): CatalogRuntime | null {
  if (requested !== undefined) {
    return (available as string[]).includes(requested) ? (requested as CatalogRuntime) : null;
  }
  // `pi` first because it is the one that completes a headless run with no extra setup.
  const preferred: CatalogRuntime[] = ["pi", "omp", "claude-code", "codex"];
  return preferred.find((runtime) => available.includes(runtime)) ?? null;
}

export async function benchCommand(options: BenchCommandOptions): Promise<number> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env["HOME"] ?? ".";
  const workspace = path.join(homeDir, ".cache", "skillful", "bench");
  const outDir = options.outDir ?? path.join(workspace, "out");

  const docker: DockerOptions = { workDir: path.join(workspace, "images"), dryRun: options.dryRun };

  // The workspace must exist before anything is probed or run. `spawn` fails with ENOENT when its
  // `cwd` does not exist, and that error is indistinguishable from a missing binary: an earlier
  // version of this command reported all four runtimes as unavailable when the real cause was a
  // missing directory. Creating it first is one line; diagnosing it again would not be.
  mkdirSync(workspace, { recursive: true });

  // --- probe ---------------------------------------------------------------
  if (options.probe) {
    const probes = await Promise.all(
      (Object.keys(ADAPTERS) as CatalogRuntime[]).map((runtime) =>
        probeAdapter(runtime, { cwd: workspace }),
      ),
    );

    if (options.json) {
      process.stdout.write(`${JSON.stringify(probes, null, 2)}\n`);
      return 0;
    }

    const lines = ["Agent runtime availability", ""];
    for (const probe of probes) {
      lines.push(`  ${probe.available ? "ok  " : "FAIL"} ${probe.runtime}: ${probe.reason}`);
      if (probe.detail.length > 0) lines.push(`         ${probe.detail}`);
    }
    const usable = probes.filter((probe) => probe.available).map((probe) => probe.runtime);
    lines.push("");
    lines.push(
      usable.length === 0
        ? "No runtime can complete a headless run, so the outcome benchmark cannot run here."
        : `Usable: ${usable.join(", ")}. Probe output is checked rather than the exit code, because every runtime on this machine exits 0 while printing an authentication or quota error.`,
    );
    process.stdout.write(`${lines.join("\n")}\n`);
    return usable.length === 0 ? 1 : 0;
  }

  // --- suite ---------------------------------------------------------------
  if (options.suite === undefined) {
    process.stderr.write("bench needs --suite <path>, or --probe to check runtimes.\n");
    return 1;
  }

  let tasks: BenchTask[];
  try {
    tasks = parseTasks(readFileSync(options.suite, "utf8"));
    assertUniqueIds(tasks);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  const selected =
    options.tasks === undefined
      ? tasks
      : tasks.filter((task) => options.tasks?.includes(task.id) === true);

  if (selected.length === 0) {
    process.stderr.write("No tasks selected.\n");
    return 1;
  }

  // --- confirm the runtime and the environment before spending any runs ----
  const probes = await Promise.all(
    (Object.keys(ADAPTERS) as CatalogRuntime[]).map((runtime) => probeAdapter(runtime, { cwd: workspace })),
  );
  const available = probes.filter((probe) => probe.available).map((probe) => probe.runtime);
  const runtime = resolveRuntime(options.runtime, available);

  const blockers: string[] = [];
  if (runtime === null) {
    blockers.push(
      `No agent runtime can complete a headless run. ${probes
        .filter((probe) => !probe.available)
        .map((probe) => `${probe.runtime}: ${probe.reason}`)
        .join(" ")}`,
    );
  }
  for (const probe of probes) {
    if (!probe.available) blockers.push(`${probe.runtime} is unavailable: ${probe.reason}`);
  }

  // Every arm of every task must resolve to the same image, and the image key must match the commit.
  const imageKeys = new Set(selected.map((task) => planImage(task, docker).key));

  if (options.dryRun) {
    const lines = [
      `Suite: ${options.suite}`,
      `Tasks: ${selected.length} across ${imageKeys.size} environment(s)`,
      `Runtime: ${runtime ?? "(none available)"}`,
      `Repeat: ${options.repeat}`,
      "",
      "Would run, one image per distinct repo@commit:",
    ];
    for (const key of imageKeys) lines.push(`  ${key}`);
    for (const blocker of blockers) lines.push(`  blocked: ${blocker}`);
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  }

  if (runtime === null) {
    // Report the blocker in the same shape as a completed run, so an incomplete benchmark is visible
    // as incomplete rather than as a suite with no tasks.
    const report = buildOutcomeReport({
      runs: [],
      excluded: [],
      repeat: options.repeat,
      blockers,
    });
    writeOutcome(outDir, report, options.json);
    return 1;
  }

  mkdirSync(workspace, { recursive: true });

  const cap = options.maxTasks ?? selected.length;  const queue = selected.slice(0, cap);

  // --- pilot ---------------------------------------------------------------
  if (options.pilot) {
    const results: ScreenResult[] = [];
    const controlRuns: TaskRunResult[] = [];

    for (const task of queue) {
      process.stderr.write(`pilot ${task.id}...\n`);
      const run = await runTask(task, 1, {
        runtime,
        docker,
        workspace,
      });
      controlRuns.push(run);
      results.push(screenCandidate(task, run.control));
    }

    // `controlRuns` holds the measurements the screening was derived from; they are written out so a
    // reader can check the classification rather than take it on trust.
    const screening = applyScreening(queue, results);

    const excluded = screening.excluded;
    writeJson(path.join(outDir, "excluded.json"), {
      total: excluded.length,
      ofCandidates: queue.length,
      excluded,
    });
    writeJson(path.join(outDir, "selected.json"), {
      selected: screening.keep,
      neutral: screening.neutral,
      probedBy: runtime,
      controlRuns,
    });

    const lines = [
      `Pilot over ${queue.length} candidate(s) using ${runtime}`,
      `  capability-bound:     ${screening.keep.length}`,
      `  not capability-bound: ${screening.neutral.length} (moved to neutral)`,
      `  excluded:             ${excluded.length}`,
      "",
      "Every exclusion is written to excluded.json with its reason, so the size of the screened",
      "sample is visible rather than implied.",
    ];
    for (const item of excluded) lines.push(`  - ${item.taskId}: ${item.reason}`);

    if (options.json) process.stdout.write(`${JSON.stringify({ screening, excluded }, null, 2)}\n`);
    else process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  }

  // --- both arms -----------------------------------------------------------
  const runs: TaskRunResult[] = [];
  for (const task of queue) {
    for (let repeat = 1; repeat <= options.repeat; repeat += 1) {
      process.stderr.write(`run ${task.id} repeat ${repeat}/${options.repeat}...\n`);
      runs.push(await runTask(task, repeat, { runtime, docker, workspace }));
    }
  }

  const environmentFailures: ExclusionRecord[] = runs
    .filter((run) => run.control.environmentError !== null)
    .map((run) => ({
      taskId: run.taskId,
      repo: run.repo,
      reason: "environment-error",
      detail: run.control.environmentError as string,
    }));

  const report = buildOutcomeReport({
    runs,
    excluded: environmentFailures,
    repeat: options.repeat,
    blockers,
  });

  writeOutcome(outDir, report, options.json);
  return 0;
}

function writeOutcome(
  outDir: string,
  report: ReturnType<typeof buildOutcomeReport>,
  json: boolean,
): void {
  mkdirSync(outDir, { recursive: true });
  writeJson(path.join(outDir, "bench-outcome.json"), report);
  writeFileSync(path.join(outDir, "bench-outcome.md"), `${renderOutcomeReport(report)}\n`, "utf8");

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    [
      `Conclusion: ${report.conclusion}`,
      renderOutcomeReport(report),
      "",
      `Written to ${outDir}/bench-outcome.json and bench-outcome.md`,
    ].join("\n"),
  );
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
