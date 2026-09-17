/**
 * Frozen environments for benchmark tasks.
 *
 * The requirement is that both arms of a task run in the **same** environment at the **same** commit.
 * Without that, a difference in outcome can be a difference in dependencies rather than a difference
 * made by injection, and no amount of statistical care downstream can recover from it. The checks
 * here enforce that rather than assuming it.
 *
 * Images are keyed by `repo@commit` and cached, because building a Python environment per task per
 * arm would dominate the wall clock of a suite. Dependencies are installed when the image is built,
 * never while a task runs, so the measured run has no network dependency.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { imageKey, type BenchTask } from "./task.js";

export interface DockerOptions {
  /** Where Dockerfiles and build logs are kept. */
  workDir: string;
  /** Emit commands instead of running them. Useful for inspection and for tests. */
  dryRun?: boolean;
  /** Docker executable. */
  dockerBin?: string;
}

export interface ImagePlan {
  key: string;
  tag: string;
  dockerfile: string;
  buildContext: string;
  notes: string[];
}

export class DockerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DockerError";
  }
}

/**
 * Produce a deterministic tag and Dockerfile for a task's environment.
 *
 * The tag derives from `repo@commit`, so two tasks from the same repository at the same commit share
 * one image, and a task cannot accidentally run against another task's environment.
 */
export function planImage(task: BenchTask, options: DockerOptions): ImagePlan {
  const key = imageKey(task);
  // Docker tags allow only a limited character set; a repository path contains a slash.
  const slug = key.replace(/[^A-Za-z0-9._-]/g, "-").toLowerCase();
  const tag = `skillful-bench:${slug}`;

  const dockerfile = [
    "FROM python:3.11-slim",
    "",
    "# git is needed to check out the exact base commit.",
    "RUN apt-get update && apt-get install -y --no-install-recommends \\",
    "      git ca-certificates build-essential \\",
    "    && rm -rf /var/lib/apt/lists/*",
    "",
    "WORKDIR /repo",
    "",
    `# Pinned to the base commit. Both arms of the task use this image,`,
    `# so the environment cannot differ between them.`,
    `ARG BASE_COMMIT=${task.baseCommit}`,
    `RUN git clone --quiet https://github.com/${task.repo}.git /repo \\`,
    "    && git checkout --quiet $BASE_COMMIT \\",
    "    && git submodule update --init --recursive --quiet || true",
    "",
    "# Dependencies are installed at build time so the measured run needs no network.",
    "RUN python -m pip install --quiet --upgrade pip \\",
    "    && (python -m pip install --quiet -e . || python -m pip install --quiet -r requirements.txt || true)",
    "",
    "# The test harness the dataset expects is installed separately so it is present even when the",
    "# repository's own install step failed.",
    "RUN python -m pip install --quiet pytest",
    "",
  ].join("\n");

  return {
    key,
    tag,
    dockerfile,
    buildContext: options.workDir,
    notes: [
      `Environment pinned to ${task.repo}@${task.baseCommit.slice(0, 10)}.`,
      "Dependencies installed at build time, so the measured run needs no network.",
    ],
  };
}

/** True when the image already exists locally. */
export async function imageExists(
  tag: string,
  options: DockerOptions,
): Promise<boolean> {
  if (options.dryRun === true) return false;
  const result = await docker(["image", "inspect", tag], options);
  return result.code === 0;
}

/**
 * Build the image if it is not cached, and return the tag either way.
 *
 * The returned tag is what both arms must use. A caller that builds its own tag has bypassed the
 * cache and, more importantly, bypassed the guarantee that both arms share one environment.
 */
export async function ensureImage(task: BenchTask, options: DockerOptions): Promise<{ tag: string; built: boolean }> {
  const plan = planImage(task, options);

  if (await imageExists(plan.tag, options)) {
    return { tag: plan.tag, built: false };
  }

  mkdirSync(options.workDir, { recursive: true });
  const dockerfilePath = path.join(options.workDir, `Dockerfile.${plan.tag.replace(/[:/]/g, "-")}`);
  writeFileSync(dockerfilePath, plan.dockerfile, "utf8");

  if (options.dryRun === true) return { tag: plan.tag, built: false };

  const result = await docker(["build", "-f", dockerfilePath, "-t", plan.tag, options.workDir], options, 3600);
  if (result.code !== 0) {
    throw new DockerError(
      `Build failed for ${plan.key}.\nA task whose environment cannot be built is excluded at the pilot stage rather than run; see excluded.json.\n${result.stderr.slice(-1500)}`,
    );
  }

  return { tag: plan.tag, built: true };
}

export interface ContainerRun {
  command: string;
  args: string[];
  /** The environment inside the container. The agent's own config is never mounted from home. */
  env: Record<string, string>;
}

/**
 * Build a container invocation for one arm.
 *
 * The isolation rules are deliberate and they are security-relevant:
 * - No real home directory is mounted, so a hook cannot read or write the user's agent config.
 * - `TYPESAFE_API_KEY` is not passed into the container. Routing is exercised by the arm switch
 *   alone; a container that could call the API would put a credential inside code that a benchmark
 *   task can modify.
 * - Only the repository directory is mounted.
 */
export function planContainer(input: {
  tag: string;
  task: BenchTask;
  /** `control` disables injection; `treatment` enables it. */
  arm: "control" | "treatment";
  /** Host directory holding the arm's working copy. */
  repoDir: string;
  /** Command to run inside. */
  command: string;
  /** Extra environment for the run. */
  env?: Record<string, string>;
}): ContainerRun {
  const env: Record<string, string> = {
    // The control arm's switch. It is the only difference between the two arms.
    SKILLFUL_DISABLE: input.arm === "control" ? "1" : "0",
    // Keep the run offline and deterministic.
    PYTHONDONTWRITEBYTECODE: "1",
    ...(input.env ?? {}),
  };

  return {
    command: "docker",
    args: [
      "run",
      "--rm",
      "--network=none",
      "-v",
      `${input.repoDir}:/repo:rw`,
      "-w",
      "/repo",
      ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      input.tag,
      "sh",
      "-lc",
      input.command,
    ],
    env,
  };
}

async function docker(
  args: readonly string[],
  options: DockerOptions,
  timeoutMs = 60_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const bin = options.dockerBin ?? "docker";

  if (options.dryRun === true) {
    return { code: 0, stdout: `${bin} ${args.join(" ")}`, stderr: "" };
  }

  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
