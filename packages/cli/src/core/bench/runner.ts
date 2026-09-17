/**
 * Running one task in both arms.
 *
 * Success is decided by the tests and by nothing else. There is no model judging the diff, no
 * heuristic reading the transcript, and no human in the loop: `failToPass` must all pass and
 * `passToPass` must all still pass. Anything softer would make the outcome depend on whoever was
 * grading, and a benchmark whose verdict is subjective cannot support a claim about effect size.
 *
 * Both arms reset to the same base commit before running. Without that reset a treatment run would
 * start from whatever the control run left behind, and the second arm would inherit the first arm's
 * changes: an effect of ordering, not of injection.
 */

import path from "node:path";
import { ADAPTERS, runProcess, type ProcessResult } from "./agent-cli.js";
import { ensureImage, planContainer, type DockerOptions } from "./docker.js";
import type { BenchTask } from "./task.js";
import type { CatalogRuntime } from "../catalog/types.js";

export type Arm = "control" | "treatment";

export interface ArmResult {
  arm: Arm;
  success: boolean;
  /** Tests that were supposed to start failing and now pass. */
  failToPassPassing: number;
  failToPassTotal: number;
  /** Tests that were supposed to keep passing and still do. */
  passToPassPassing: number;
  passToPassTotal: number;
  /** Whether the router actually injected on the treatment arm. */
  injectionObserved: boolean;
  agentDurationMs: number;
  testDurationMs: number;
  /** Truncated output, kept so a failure can be classified later. */
  agentOutputTail: string;
  testOutputTail: string;
  environmentError: string | null;
}

export interface TaskRunResult {
  taskId: string;
  repo: string;
  group: string;
  control: ArmResult;
  treatment: ArmResult;
  repeat: number;
}

export interface RunnerOptions {
  runtime: CatalogRuntime;
  docker: DockerOptions;
  /** Base directory holding one working copy per arm. */
  workspace: string;
  /** Timeout for the agent's turn, per arm. */
  agentTimeoutMs?: number;
  /** Timeout for the test command. */
  testTimeoutMs?: number;
}

const DEFAULT_AGENT_TIMEOUT_MS = 900_000;
const DEFAULT_TEST_TIMEOUT_MS = 900_000;

/**
 * Decide the test verdict from the command's output.
 *
 * The test command is run once before the agent acts, to confirm the task starts in a failing state.
 * A task whose tests already pass on the base commit is not a valid task: it has no gap for the
 * agent to close, and whichever arm it lands in it contributes a pass that means nothing.
 */
export function evaluateTests(input: {
  output: string;
  exitCode: number | null;
  failToPass: readonly string[];
  passToPass: readonly string[];
}): { success: boolean; failToPassPassing: number; passToPassPassing: number; note: string } {
  const { output } = input;

  // pytest's summary lines report each of these. A missing test is treated as failing, because a
  // test that does not run has not passed.
  const countPassing = (names: readonly string[]): number =>
    names.filter((name) => testPassed(output, name)).length;

  const failToPassPassing = countPassing(input.failToPass);
  const passToPassPassing = countPassing(input.passToPass);

  const success =
    input.exitCode === 0 &&
    failToPassPassing === input.failToPass.length &&
    passToPassPassing === input.passToPass.length;

  let note = "";
  if (input.exitCode !== 0 && failToPassPassing === input.failToPass.length) {
    note = "All target tests passed but the command exited non-zero, so the verdict is failure.";
  } else if (failToPassPassing < input.failToPass.length) {
    note = `${input.failToPass.length - failToPassPassing} of ${input.failToPass.length} target test(s) still failing.`;
  }

  return { success, failToPassPassing, passToPassPassing, note };
}

/**
 * Whether one test id appears as passing in the output.
 *
 * pytest prints `path::test PASSED` in verbose mode and lists `FAILED path::test` in the short
 * summary. Both are checked, and a test named in the failure summary is treated as failing even if
 * the word PASSED appears elsewhere for a similarly named parameterisation.
 */
export function testPassed(output: string, testId: string): boolean {
  const escaped = testId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const failed = new RegExp(`FAILED\\s+${escaped}`, "m");
  const passed = new RegExp(`(PASSED|passed)\\s+${escaped}|${escaped}\\s+PASSED`, "m");

  if (failed.test(output)) return false;
  return passed.test(output);
}

/**
 * Run one task in one arm.
 *
 * The image is ensured before the run so a build failure surfaces as an environment error rather
 * than as a solved-or-unsolved task, and the caller excludes it rather than counting it.
 */
export async function runArm(input: {
  task: BenchTask;
  arm: Arm;
  repeat: number;
  options: RunnerOptions;
}): Promise<ArmResult> {
  const { task, arm, options } = input;

  const empty = (message: string): ArmResult => ({
    arm,
    success: false,
    failToPassPassing: 0,
    failToPassTotal: task.failToPass.length,
    passToPassPassing: 0,
    passToPassTotal: task.passToPass.length,
    injectionObserved: false,
    agentDurationMs: 0,
    testDurationMs: 0,
    agentOutputTail: "",
    testOutputTail: "",
    environmentError: message,
  });

  let tag: string;
  try {
    ({ tag } = await ensureImage(task, options.docker));
  } catch (error) {
    return empty((error as Error).message);
  }

  const repoDir = path.join(options.workspace, sanitise(task.id), arm, `r${input.repeat}`);

  // 1. Baseline: the task must fail before the agent touches it. If it passes, the task has no gap
  //    and the run is not evidence about anything.
  const baseline = await runInContainer({
    tag,
    task,
    arm,
    repoDir,
    command: task.testCommand,
    options,
    timeoutMs: options.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
  });

  if (baseline === null) return empty("Could not run the baseline test command in the container.");

  const baselineVerdict = evaluateTests({
    output: `${baseline.stdout}\n${baseline.stderr}`,
    exitCode: baseline.code,
    failToPass: task.failToPass,
    passToPass: task.passToPass,
  });

  if (baselineVerdict.failToPassPassing === task.failToPass.length) {
    return empty(
      "The target tests already pass at the base commit, so this task has no gap for the agent to close. Excluded at the pilot stage.",
    );
  }

  // 2. The agent's turn. The prompt is the problem statement exactly as the dataset provides it,
  //    with no added hints, because adding hints would measure the hints.
  const adapter = ADAPTERS[options.runtime];
  const agent: ProcessResult = await runProcess(adapter.binary, adapter.args(task.problemStatement), {
    cwd: repoDir,
    env: { ...process.env, ...(adapter.env ?? {}), SKILLFUL_DISABLE: arm === "control" ? "1" : "0" },
    timeoutMs: options.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
  });

  // 3. The verdict.
  const after = await runInContainer({
    tag,
    task,
    arm,
    repoDir,
    command: task.testCommand,
    options,
    timeoutMs: options.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
  });

  if (after === null) return empty("Could not run the test command after the agent's turn.");

  const output = `${after.stdout}\n${after.stderr}`;
  const verdict = evaluateTests({
    output,
    exitCode: after.code,
    failToPass: task.failToPass,
    passToPass: task.passToPass,
  });

  return {
    arm,
    success: verdict.success,
    failToPassPassing: verdict.failToPassPassing,
    failToPassTotal: task.failToPass.length,
    passToPassPassing: verdict.passToPassPassing,
    passToPassTotal: task.passToPass.length,
    // Read from the arm's own telemetry rather than inferred from the switch: a hook that degraded
    // did not inject, and counting a degraded run as injected would dilute the effect.
    injectionObserved: arm === "treatment" && detectInjection(repoDir),
    agentDurationMs: agent.durationMs,
    testDurationMs: after.durationMs ?? 0,
    agentOutputTail: tail(agent.stdout, 2000),
    testOutputTail: tail(output, 4000),
    environmentError: agent.timedOut ? "The agent timed out." : null,
  };
}

/**
 * Whether the treatment arm actually received an injection.
 *
 * Read from the run's own environment rather than assumed from the switch position, because
 * `SKILLFUL_DISABLE=0` means "not disabled", which is not the same as "routed and injected".
 */
function detectInjection(repoDir: string): boolean {
  try {
    const logPath = path.join(repoDir, ".skillful-bench", "injection.json");
    // Imported lazily so this module has no hard dependency on the file existing.
    const raw = require("node:fs").readFileSync(logPath, "utf8") as string;
    return JSON.parse(raw).injected === true;
  } catch {
    // No record means no observed injection. Recording an assumption here would be the one place a
    // benchmark could silently report an effect that never happened.
    return false;
  }
}

async function runInContainer(input: {
  tag: string;
  task: BenchTask;
  arm: Arm;
  repoDir: string;
  command: string;
  options: RunnerOptions;
  timeoutMs: number;
}): Promise<ProcessResult | null> {
  const plan = planContainer({
    tag: input.tag,
    task: input.task,
    arm: input.arm,
    repoDir: input.repoDir,
    command: input.command,
  });

  try {
    return await runProcess(plan.command, plan.args, {
      cwd: input.options.workspace,
      timeoutMs: input.timeoutMs,
    });
  } catch {
    return null;
  }
}

/** Run one task in both arms, in order, at the same commit. */
export async function runTask(
  task: BenchTask,
  repeat: number,
  options: RunnerOptions,
): Promise<TaskRunResult> {
  const control = await runArm({ task, arm: "control", repeat, options });
  const treatment = await runArm({ task, arm: "treatment", repeat, options });

  return {
    taskId: task.id,
    repo: task.repo,
    group: task.group,
    control,
    treatment,
    repeat,
  };
}

function sanitise(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

function tail(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(-limit);
}
