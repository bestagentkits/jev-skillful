/**
 * SWE-bench-style task loading.
 *
 * Tasks come from a real dataset rather than being written by hand, because a task set invented by
 * the author of the tool tests the author's beliefs about what the tool should help with. The format
 * is the SWE-bench one, which is what the public datasets use.
 *
 * Two fields are load-bearing and their absence is an error rather than a warning. `failToPass` is
 * the definition of success: at least one of those tests must go from failing to passing. Without it
 * there is no objective outcome and the whole benchmark is opinion. `testCommand` is how the verdict
 * is obtained, and a task with no way to run its tests cannot produce a result.
 */

export const TASK_GROUPS = ["capability-bound", "mcp-bound", "neutral", "adversarial"] as const;
export type TaskGroup = (typeof TASK_GROUPS)[number];

export interface BenchTask {
  id: string;
  repo: string;
  /** The commit the repository is checked out at, identical in both arms. */
  baseCommit: string;
  problemStatement: string;
  /** How the tests are run. The verdict comes from this and from nothing else. */
  testCommand: string;
  /** Tests that must pass after the change and do not pass before it. */
  failToPass: string[];
  /** Tests that must keep passing. */
  passToPass: string[];
  /** The catalog capability believed to apply. Recorded, not enforced. */
  capabilityHint?: string;
  group: TaskGroup;
  /** Upstream difficulty label, when the dataset has one. */
  difficulty?: string;
}

export class TaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskError";
  }
}

/** Parse one raw record into a task, throwing with a specific reason when it cannot be used. */
export function parseTask(raw: unknown, fallbackTestCommand?: string): BenchTask {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TaskError("Task must be an object");
  }

  const record = raw as Record<string, unknown>;

  const id = stringField(record, ["id", "instance_id"]);
  const repo = stringField(record, ["repo", "repoName"]);
  const baseCommit = stringField(record, ["baseCommit", "base_commit"]);
  const problemStatement = stringField(record, ["problemStatement", "problem_statement"]);

  const testCommand =
    optionalString(record, ["testCommand", "test_command"]) ?? fallbackTestCommand;
  if (testCommand === undefined) {
    throw new TaskError(
      `${id}: no testCommand. A task whose tests cannot be run has no objective outcome, so it cannot be benchmarked.`,
    );
  }

  const failToPass = stringArray(record, ["failToPass", "FAIL_TO_PASS"]);
  if (failToPass.length === 0) {
    throw new TaskError(
      `${id}: failToPass is empty. Success is defined as those tests going from failing to passing, so without them there is nothing to measure.`,
    );
  }

  const group = optionalString(record, ["group"]);
  if (group !== undefined && !isTaskGroup(group)) {
    throw new TaskError(`${id}: unknown group "${group}" (expected one of ${TASK_GROUPS.join(", ")})`);
  }

  return {
    id,
    repo,
    baseCommit,
    problemStatement,
    testCommand,
    failToPass,
    passToPass: stringArray(record, ["passToPass", "PASS_TO_PASS"]),
    ...(optionalString(record, ["capabilityHint", "capability_hint"]) === undefined
      ? {}
      : { capabilityHint: optionalString(record, ["capabilityHint", "capability_hint"]) as string }),
    // A task with no group defaults to `capability-bound`, because the selection process already
    // filtered out anything the capability could not apply to.
    group: (group as TaskGroup | undefined) ?? "capability-bound",
    ...(optionalString(record, ["difficulty"]) === undefined
      ? {}
      : { difficulty: optionalString(record, ["difficulty"]) as string }),
  };
}

/** Parse a JSON array or a JSONL file into tasks. */
export function parseTasks(text: string, fallbackTestCommand?: string): BenchTask[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  // A JSON array is the shape a dataset export takes; JSONL is the shape a hand-curated file takes.
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      // Rethrown as a TaskError so every failure from this module has one type a caller can catch,
      // and so the message names the file's shape rather than a character offset.
      throw new TaskError(`Not valid JSON: ${(error as Error).message}`);
    }
    if (!Array.isArray(parsed)) throw new TaskError("Expected a JSON array of tasks");
    return parsed.map((entry) => parseTask(entry, fallbackTestCommand));
  }

  const tasks: BenchTask[] = [];
  const failures: string[] = [];

  for (const [index, line] of trimmed.split("\n").entries()) {
    if (line.trim().length === 0) continue;
    try {
      // Both parses are guarded: the outer one here, and the field parse inside `parseTask`.
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        throw new TaskError("not valid JSON");
      }
      tasks.push(parseTask(record, fallbackTestCommand));
    } catch (error) {
      failures.push(`line ${index + 1}: ${(error as Error).message}`);
    }
  }

  if (tasks.length === 0 && failures.length > 0) {
    throw new TaskError(`No usable tasks.\n${failures.join("\n")}`);
  }

  return tasks;
}

/** True when every task in the list has a unique id. */
export function assertUniqueIds(tasks: readonly BenchTask[]): void {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) throw new TaskError(`Duplicate task id: ${task.id}`);
    seen.add(task.id);
  }
}

/** The identity a Docker image is cached under. Both arms of a task must resolve to the same one. */
export function imageKey(task: Pick<BenchTask, "repo" | "baseCommit">): string {
  return `${task.repo}@${task.baseCommit}`;
}

function isTaskGroup(value: string): value is TaskGroup {
  return (TASK_GROUPS as readonly string[]).includes(value);
}

function stringField(record: Record<string, unknown>, names: readonly string[]): string {
  const value = optionalString(record, names);
  if (value === undefined) {
    throw new TaskError(`Missing required field: one of ${names.join(", ")}`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/**
 * Read a string list, tolerating the two shapes the datasets use.
 *
 * SWE-bench stores `FAIL_TO_PASS` as a JSON-encoded string, while a hand-curated file would naturally
 * store an array. Both are accepted because rejecting one of them would make the loader fail on the
 * real dataset, which is the only dataset that matters.
 */
function stringArray(record: Record<string, unknown>, names: readonly string[]): string[] {
  for (const name of names) {
    const value = record[name];
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
    if (typeof value === "string" && value.trim().startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (Array.isArray(parsed)) {
          return parsed.filter((item): item is string => typeof item === "string");
        }
      } catch {
        // Fall through to the empty list; a malformed list is reported by the caller's emptiness check.
      }
    }
  }
  return [];
}
