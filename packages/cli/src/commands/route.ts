/**
 * `skillful route` — run the router against one prompt and show what it decided.
 *
 * This is the manual surface for phase 2 and the debugging surface for every phase after
 * it. `--explain` deliberately prints the shortlist and the scores, because the most
 * likely reason routing looks wrong is that BM25 never put the right candidate in front of
 * the model.
 */

import { API_KEY_ENV, resolveApiKey, resolveConfig, route } from "../core/index.js";
import type { DegradedReason, RouteResult, SkipReason } from "../core/index.js";
import { scanCatalog } from "../core/index.js";

export interface RouteCommandOptions {
  prompt: string | undefined;
  json: boolean;
  explain: boolean;
  /** Route only these kinds, bypassing the default quota groups. */
  model?: string;
  uploadPrompt?: boolean;
}

const DEGRADED_ADVICE: Record<DegradedReason, string> = {
  auth: `The API key was rejected. Check that ${API_KEY_ENV} holds a current key.`,
  config: `No API key found. Export ${API_KEY_ENV} before routing.`,
  network: "The request never reached TypeSafe. Check connectivity and retry.",
  timeout: "Routing exceeded its budget. Raise budgetMs or lower requestTimeoutMs.",
  upstream: "TypeSafe returned an error. This is usually transient.",
  malformed: "TypeSafe returned a body this client could not read.",
};

const SKIP_EXPLANATION: Record<SkipReason, string> = {
  heuristic: "Skipped without a network call.",
  "none-won": "The model judged that no listed capability is needed.",
  "below-threshold": "A winner existed but the model was not confident enough to act on it.",
  "empty-shortlist": "The catalog produced no candidates to ask about.",
};

/**
 * Run the route command and return a process exit code.
 *
 * A skipped or degraded route is **not** a failure: the hook that calls this in phase 4
 * must treat "inject nothing" as a normal outcome. Exit code 0 covers a completed routing
 * decision of any kind. A non-zero code is reserved for the command itself being unable to
 * run, such as a prompt that was never supplied.
 */
export async function routeCommand(options: RouteCommandOptions): Promise<number> {
  const prompt = options.prompt?.trim() ?? "";

  if (prompt.length === 0) {
    process.stderr.write(
      "No prompt supplied. Pass --prompt \"...\" or pipe the prompt on stdin.\n",
    );
    return 1;
  }

  const resolved = resolveConfig({
    ...(options.model === undefined ? {} : { cli: { model: options.model } }),
  });

  for (const warning of resolved.warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }

  const catalog = await scanCatalog({});
  const apiKey = resolveApiKey({});

  // A missing key is reported up front rather than after a scan, because the scan is the
  // slow part and the user can fix a missing key without rerunning anything.
  if (apiKey === undefined && options.json !== true) {
    process.stderr.write(
      `warning: ${API_KEY_ENV} is not set, so routing can only report a degraded result.\n`,
    );
  }

  const result = await route(prompt, {
    entries: catalog.entries,
    thresholds: resolved.config.thresholds,
    quotaGroups: resolved.config.quotaGroups,
    model: resolved.config.model,
    baseUrl: resolved.config.baseUrl,
    uploadPrompt: options.uploadPrompt ?? resolved.config.uploadPrompt,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...result, catalogFingerprint: catalog.fingerprint }, null, 2)}\n`);
    return 0;
  }

  printResult(result, options.explain);
  return 0;
}

function printResult(result: RouteResult, explain: boolean): void {
  const decision = result.decision;

  process.stdout.write(`\nDecision: ${decision.kind.toUpperCase()}\n`);

  if (decision.kind === "injected") {
    process.stdout.write(`\n  Primary   [${decision.primary.kind}] ${decision.primary.name}\n`);
    process.stdout.write(`            ${decision.primary.sourcePath}\n`);
    if (decision.primary.description !== "") {
      process.stdout.write(`            ${decision.primary.description}\n`);
    }

    if (decision.runnersUp.length === 0) {
      process.stdout.write("\n  No runner-up cleared the threshold.\n");
    }
    for (const runnerUp of decision.runnersUp) {
      process.stdout.write(
        `\n  Runner-up [${runnerUp.kind}] ${runnerUp.name}  (noul ${runnerUp.noul.toFixed(2)})\n`,
      );
      process.stdout.write(`            ${runnerUp.sourcePath}\n`);
    }
    process.stdout.write(`\n  noneP ${decision.noneP.toFixed(3)} · confidence ${decision.confidence.toFixed(3)}\n`);
  } else if (decision.kind === "skipped") {
    process.stdout.write(`  ${SKIP_EXPLANATION[decision.reason]}\n`);
    if (decision.detail !== undefined) {
      process.stdout.write(`  Reason: ${decision.detail}\n`);
    }
  } else {
    process.stdout.write(`  ${DEGRADED_ADVICE[decision.reason]}\n`);
    if (decision.detail !== undefined) {
      process.stdout.write(`  Detail: ${decision.detail}\n`);
    }
  }

  if (explain) {
    process.stdout.write("\nShortlist sent to the model:\n");
    if (result.shortlistDetail.length === 0) {
      process.stdout.write("  (none)\n");
    }
    for (const item of result.shortlistDetail) {
      process.stdout.write(`  ${item.score.toFixed(3).padStart(7)}  ${item.kind.padEnd(7)} ${item.id}\n`);
    }
    printRanking(result);
  }

  process.stdout.write(
    `\n${result.latencyMs}ms · prompt ${result.promptChars} chars · model ${result.model}` +
      `${result.tokensIn === undefined ? "" : ` · tokens ${result.tokensIn} in / ${result.tokensOut ?? 0} out`}` +
      `${result.cacheHit ? " · cache hit" : ""}\n\n`,
  );
}

function printRanking(result: RouteResult): void {
  if (result.ranking.length === 0) return;

  process.stdout.write("\nPer-candidate noul ranking:\n");
  for (const ranked of result.ranking) {
    process.stdout.write(`  ${ranked.noul.toFixed(3).padStart(7)}  ${ranked.id}\n`);
  }

  if (result.primary !== undefined) {
    process.stdout.write(
      `\nWinner probability ${result.primary.probability.toFixed(3)} · noneP ${result.primary.noneP.toFixed(3)}\n`,
    );
  }
}
