/**
 * Headless adapters for the four agent runtimes.
 *
 * Every flag here was read off the runtime's own `--help` output on this machine rather than taken
 * from documentation, because a wrong flag produces an empty run that looks like a task the agent
 * could not solve. That is the worst possible failure here: it would be recorded as a failure for
 * whichever arm it happened in and would look like an effect.
 *
 * The availability check is separate from the invocation on purpose. A runtime that cannot run
 * headless must be excluded before a suite starts, not discovered halfway through when half the
 * sample has been collected from a different arm composition.
 */

import { spawn } from "node:child_process";
import type { CatalogRuntime } from "../catalog/types.js";

export interface HeadlessAdapter {
  runtime: CatalogRuntime;
  /** Executable name. */
  binary: string;
  /** Arguments that put the runtime in non-interactive mode and pass the prompt. */
  args: (prompt: string) => string[];
  /** Extra environment the runtime needs. */
  env?: Record<string, string>;
}

/**
 * Verified against live `--help` output on this machine:
 *
 *   claude   `-p, --print`                      non-interactive
 *   codex    `codex exec`                       subcommand, not a flag
 *   pi       `--print, -p`, `--mode text|json|rpc`
 *   omp      `--mode`, `--model=`, `--provider=`
 */
export const ADAPTERS: Record<CatalogRuntime, HeadlessAdapter> = {
  "claude-code": {
    runtime: "claude-code",
    binary: "claude",
    args: (prompt) => ["-p", prompt, "--output-format", "text"],
  },
  codex: {
    runtime: "codex",
    binary: "codex",
    // `exec` is a subcommand, so it comes before the prompt.
    args: (prompt) => ["exec", "--skip-git-repo-check", prompt],
  },
  pi: {
    runtime: "pi",
    binary: "pi",
    args: (prompt) => ["--print", prompt, "--mode", "text"],
  },
  omp: {
    runtime: "omp",
    binary: "omp",
    args: (prompt) => ["--print", prompt, "--mode", "text"],
  },
};

export interface AdapterProbe {
  runtime: CatalogRuntime;
  available: boolean;
  /** Why it is unavailable, written so a reader can act on it. */
  reason: string;
  /** Short output from the probe, for the report. */
  detail: string;
}

/** Sentinel prompt. The answer does not matter; whether the runtime responds at all does. */
const PROBE_PROMPT = "reply with exactly: OK";
const PROBE_TIMEOUT_MS = 120_000;

/**
 * Check whether a runtime can actually complete a headless run.
 *
 * Runs a real prompt rather than checking for a binary on `PATH`, because a binary that exists but
 * whose credentials have expired fails at the first real task instead of here. Claude Code and Codex
 * both fail this way on this machine, and finding that out during a suite would have wasted the runs
 * that came before it.
 */
export async function probeAdapter(
  runtime: CatalogRuntime,
  options: { cwd: string; env?: Readonly<Record<string, string | undefined>>; timeoutMs?: number } = { cwd: process.cwd() },
): Promise<AdapterProbe> {
  const adapter = ADAPTERS[runtime];

  try {
    const result = await runProcess(adapter.binary, adapter.args(PROBE_PROMPT), {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
    });

    const output = `${result.stdout}\n${result.stderr}`;

    // The exit code is not a reliable signal: every runtime here exited 0 while printing an
    // authentication or quota error, so the output is what decides.
    const failure = detectFailure(output);
    if (failure !== null) {
      return { runtime, available: false, reason: failure, detail: firstLines(output, 3) };
    }

    if (result.timedOut) {
      return {
        runtime,
        available: false,
        reason: `Did not finish within ${Math.round((options.timeoutMs ?? PROBE_TIMEOUT_MS) / 1000)}s.`,
        detail: firstLines(output, 3),
      };
    }

    if (result.stdout.trim().length === 0) {
      return { runtime, available: false, reason: "Produced no output for a trivial prompt.", detail: "" };
    }

    return { runtime, available: true, reason: "Responded to a trivial prompt.", detail: firstLines(output, 1) };
  } catch (error) {
    return {
      runtime,
      available: false,
      reason: `Could not start ${adapter.binary}: ${(error as Error).message}`,
      detail: "",
    };
  }
}

/**
 * Recognise the failure strings these runtimes print while still exiting 0.
 *
 * Matching on text is ugly, and it is what the runtimes force: an expired OAuth session and an
 * exhausted quota both produce a normal exit. A probe that trusted the exit code would report four
 * working runtimes and then collect a suite of empty runs.
 */
export function detectFailure(output: string): string | null {
  const lowered = output.toLowerCase();

  if (lowered.includes("oauth session expired") || lowered.includes("failed to authenticate")) {
    return "Authentication expired. Re-authenticate the runtime before benchmarking.";
  }
  if (lowered.includes("usage limit") || lowered.includes("quota")) {
    return "Quota or usage limit reached.";
  }
  if (lowered.includes("not logged in") || lowered.includes("please log in") || lowered.includes("api key")) {
    return "Not authenticated.";
  }
  if (lowered.includes("command not found")) {
    return "Binary not found on PATH.";
  }

  return null;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  /** Wall-clock milliseconds. */
  durationMs: number;
}

/**
 * Run a process to completion with a timeout.
 *
 * Never rejects on a non-zero exit: callers decide whether that matters, and a test command exiting
 * non-zero is the normal way a failing test reports itself.
 */
export function runProcess(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    /** Written to stdin then closed. An agent that waits for input would otherwise hang. */
    stdin?: string;
  },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let timedOut = false;

    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 900_000);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut, durationMs: Date.now() - startedAt });
    });

    child.stdin.on("error", () => {});
    child.stdin.end(options.stdin ?? "");
  });
}

function firstLines(text: string, count: number): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, count)
    .join(" | ");
}
