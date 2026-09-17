/**
 * `skillful hook` — the entry point Claude Code and Codex invoke on every prompt.
 *
 * The contract, and the only thing about this command that matters:
 *
 * - Read one JSON object from stdin.
 * - Write one JSON object to stdout.
 * - **Always exit 0.**
 *
 * Nothing is written to stderr, ever. An agent that shows its user a stack trace on every
 * prompt because of a routing failure would be worse than no router at all, so diagnostics go
 * to `skillful doctor` instead of into the user's terminal.
 */

import { runHook, type HookInput } from "../core/hooks/runner.js";
import { scanCatalog } from "../core/catalog/scan.js";

export interface HookCommandOptions {
  homeDir?: string;
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Raw stdin text. Empty or malformed input is tolerated and treated as "no prompt". */
  stdin: string;
}

/** Parse stdin into a hook input, tolerating anything that is not the expected shape. */
export function parseHookInput(stdin: string): HookInput {
  const trimmed = stdin.trim();
  if (trimmed.length === 0) return { prompt: "" };

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      // Some runtimes have been known to pass the raw prompt rather than a JSON envelope, so
      // a bare string body is treated as the prompt instead of as an error.
      return { prompt: trimmed };
    }
    const record = parsed as Record<string, unknown>;
    const prompt =
      typeof record["prompt"] === "string"
        ? record["prompt"]
        : typeof record["user_prompt"] === "string"
          ? record["user_prompt"]
          : "";
    return {
      prompt,
      ...(typeof record["session_id"] === "string" ? { session_id: record["session_id"] } : {}),
      ...(typeof record["cwd"] === "string" ? { cwd: record["cwd"] } : {}),
      ...(typeof record["hook_event_name"] === "string"
        ? { hook_event_name: record["hook_event_name"] }
        : {}),
    };
  } catch {
    return { prompt: trimmed };
  }
}

/**
 * Run the hook and print its payload.
 *
 * Returns 0 unconditionally. The exit code is part of the contract: a non-zero exit is how a
 * hook signals failure to the host, and this hook must never signal failure.
 */
export async function hookCommand(options: HookCommandOptions): Promise<number> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env["HOME"] ?? ".";
  const input = parseHookInput(options.stdin);

  const outcome = await runHook(input, {
    homeDir,
    cwd: options.cwd ?? input.cwd ?? process.cwd(),
    env,
    scan: scanCatalog,
  });

  process.stdout.write(`${JSON.stringify(outcome.payload)}\n`);
  return 0;
}
