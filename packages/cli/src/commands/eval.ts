/**
 * `skillful eval` — the quality gate.
 *
 * Runs the router over a fixture set and compares the result against fixed criteria. This is
 * the command that decides whether phase 4 is allowed to start, so it reports sample sizes
 * and a per-group breakdown rather than a single headline number.
 */

import { readFileSync } from "node:fs";
import {
  buildShortlist,
  DEFAULT_QUOTA_GROUPS,
  DEFAULT_THRESHOLDS,
  evaluateGate,
  loadCorpus,
  parseFixtures,
  resolveFixtures,
  route,
  saveCorpus,
  scanCatalog,
  renderGateText,
  renderMarkdown,
  renderSweep,
  runEval,
  runSweep,
  quotaGroupsWithSkillLimit,
  resolveConfig,
  truncatePrompt,
} from "../core/index.js";
import type {
  CatalogEntry,
  EvalReport,
  ResolvedFixture,
  RouteCaller,
  SweepPoint,
} from "../core/index.js";
import { loadReplay, makeReplayFetch, Recorder, saveReplay } from "../core/eval/replay.js";

export interface EvalCommandOptions {
  /** Defaults to the development fixture set. */
  fixtures?: string;
  /** Defaults to the committed corpus snapshot. */
  corpus?: string;
  repeat: number;
  limit?: number;
  json: boolean;
  explain: boolean;
  sweep: boolean;
  /** Scan the live catalog and write a sanitised snapshot here, then exit. */
  snapshotCorpus?: string;
  /** Include private-project entries in the snapshot. Off by default. */
  includePrivate: boolean;
  /** Record live responses here for later `--replay`. */
  record?: string;
  /** Answer from a recording instead of the network. */
  replay?: string;
  /** Sweep quotas and report recall only. No API call, because recall is purely local. */
  recallOnly: boolean;
  budgetMs?: number;
}

const DEFAULT_FIXTURES = "bench/fixtures/routing.jsonl";
const DEFAULT_CORPUS = "bench/corpus/distractors.json";

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Read a file, turning a missing file into a clear message rather than a stack trace. */
function readText(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    throw new Error(`Cannot read ${filePath}. Run from the repository root.`);
  }
}

/** A caller that routes against the live API, optionally recording what comes back. */
function makeLiveCaller(recordingFetch?: typeof fetch): RouteCaller {
  return (prompt, options) =>
    route(prompt, {
      entries: options.entries,
      thresholds: options.thresholds,
      quotaGroups: options.quotaGroups,
      model: options.model,
      uploadPrompt: options.uploadPrompt,
      ...(recordingFetch === undefined ? {} : { jev: { fetchImpl: recordingFetch } }),
    });
}

/** A caller that routes through the production code path but reads responses from a file. */
function makeReplayCaller(replayFetch: typeof fetch): RouteCaller {
  return (prompt, options) =>
    route(prompt, {
      entries: options.entries,
      thresholds: options.thresholds,
      quotaGroups: options.quotaGroups,
      model: options.model,
      uploadPrompt: options.uploadPrompt,
      jev: {
        apiKey: "replay",
        fetchImpl: replayFetch,
        // Recorded responses are returned immediately, so backoff would only waste time.
        sleepImpl: async () => {},
        maxRetries: 0,
      },
    });
}

export async function evalCommand(options: EvalCommandOptions): Promise<number> {
  if (options.snapshotCorpus !== undefined) {
    return snapshotCorpus(options.snapshotCorpus, options.includePrivate);
  }

  const resolved = resolveConfig(options.budgetMs === undefined ? {} : { cli: { thresholds: { budgetMs: options.budgetMs } } });
  for (const warning of resolved.warnings) log(`warning: ${warning}`);

  const corpus = loadEvalCorpus(options.corpus);
  const fixturesPath = options.fixtures ?? DEFAULT_FIXTURES;

  let fixtures: ResolvedFixture[];
  try {
    fixtures = resolveFixtures(parseFixtures(readText(fixturesPath), fixturesPath), corpus.entries);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (options.limit !== undefined && options.limit > 0) {
    fixtures = fixtures.slice(0, options.limit);
  }

  const repeat = Math.max(1, options.repeat);

  // Recording wraps the real network so the recorded body is byte-identical to what the
  // router actually consumed.
  const recorder = new Recorder();
  const taskToFixture = new Map<string, string>();
  for (const fixture of fixtures) {
    taskToFixture.set(fixture.prompt.slice(0, resolved.config.thresholds.maxPromptChars), fixture.id);
  }

  const caller = options.replay !== undefined
    ? (() => {
        const replay = loadReplay(options.replay);
        const { fetch, missing } = makeReplayFetch(replay);
        if (missing.length > 0) {
          log(`warning: ${missing.length} request(s) had no recording and became degraded`);
        }
        log(`replaying ${Object.keys(replay).length} recorded fixtures from ${options.replay}`);
        return makeReplayCaller(fetch);
      })()
    : makeLiveCaller(
        options.record === undefined
          ? undefined
          : recorder.fetch(globalThis.fetch, (task) => taskToFixture.get(task)),
      );

  const config = {
    thresholds: resolved.config.thresholds,
    quotaGroups: resolved.config.quotaGroups,
    model: resolved.config.model,
    baseUrl: resolved.config.baseUrl,
    uploadPrompt: resolved.config.uploadPrompt,
  };

  if (options.sweep) {
    return runSweepCommand({ fixtures, entries: corpus.entries, repeat, config, options });
  }

  if (options.recallOnly) {
    return recallOnlyCommand(fixtures, corpus.entries);
  }

  log(`running ${fixtures.length} fixtures × ${repeat} = ${fixtures.length * repeat} routes`);
  const report = await runEval({
    fixtures,
    entries: corpus.entries,
    repeat,
    config,
    callRoute: caller,
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) log(`  ${done}/${total}`);
    },
  });

  if (options.record !== undefined) {
    saveReplay(options.record, recorder.recorded);
    log(`recorded ${recorder.count} responses to ${options.record}`);
  }

  emit(report, options, corpus, fixturesPath);

  if (!options.json && fixtures.length * repeat < report.meta.totalRuns) {
    log("warning: fewer runs completed than requested");
  }

  // A failed gate is a legitimate outcome, and the caller reads it from the output rather
  // than from the exit code, so the command itself still succeeded.
  return 0;
}

async function runSweepCommand(input: {
  fixtures: readonly ResolvedFixture[];
  entries: readonly CatalogEntry[];
  repeat: number;
  config: Parameters<typeof runEval>[0]["config"];
  options: EvalCommandOptions;
}): Promise<number> {
  const { fixtures, repeat, config, options } = input;

  // `recall@K` depends only on the shortlist, and the shortlist is built entirely locally from
  // BM25 and the quota groups. Every quota point can therefore be measured without a single
  // API call, which makes exhaustive quota tuning free. The threshold axes are what cost
  // money, so they are swept with a small grid.
  const grid = {
    noneThreshold: [0.4, 0.5, 0.6],
    skillQuota: [6],
    minWinnerProbability: [0.1, 0.25, 0.4],
  };
  const total =
    grid.noneThreshold.length * grid.skillQuota.length * grid.minWinnerProbability.length;
  log(`sweeping ${total} configurations × ${fixtures.length} fixtures × ${repeat} repeats = ${total * fixtures.length * repeat} routes`);

  const replay = options.replay === undefined ? undefined : loadReplay(options.replay);
  const caller = replay === undefined ? undefined : makeReplayCaller(makeReplayFetch(replay).fetch);

  const points = await runSweep({
    fixtures,
    entries: input.entries,
    repeat,
    baseConfig: config,
    grid,
    quotaGroupsFor: (skillQuota: number) => quotaGroupsWithSkillLimit(skillQuota, DEFAULT_QUOTA_GROUPS),
    ...(caller === undefined ? {} : { callRoute: caller }),
    onPoint: (point: SweepPoint, done: number) => {
      log(
        `  ${done}/${total}  noneThreshold=${point.noneThreshold} skillQuota=${point.skillQuota}  ` +
          `top1=${point.summary.top1Accuracy.toFixed(3)} noneRecall=${point.summary.noneRecall.toFixed(3)} ` +
          `${point.summary.passed ? "PASS" : "fail"}`,
      );
    },
  });

  const markdown = renderSweep({
    grid,
    repeat,
    points,
    corpusFingerprint: "see report",
    ranAt: new Date().toISOString(),
  });

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          grid,
          repeat,
          points: points.map((point) => ({
            noneThreshold: point.noneThreshold,
            skillQuota: point.skillQuota,
            // Every swept axis has to appear here. Omitting one produces a result table whose
            // rows cannot be attributed to a configuration, which is the same as not having run
            // the sweep — and it happened once, with this exact field.
            minWinnerProbability: point.minWinnerProbability,
            ...(point.runnerUpThreshold === undefined
              ? {}
              : { runnerUpThreshold: point.runnerUpThreshold }),
            gatePassed: point.summary.passed,
            summary: point.summary,
            failing: point.gate.checks.filter((check) => !check.ok).map((check) => check.name),
          })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${markdown}\n`);
  }

  return 0;
}

function emit(
  report: EvalReport,
  options: EvalCommandOptions,
  corpus: { fingerprint: string; capturedAt: string; sanitised: boolean; excludedCount: number },
  fixtureSource: string,
): void {
  const result = evaluateGate(report);

  const provenance = {
    fixtureSource,
    mode: options.replay === undefined ? "live" : "replay",
    corpusFingerprint: corpus.fingerprint,
    corpusCapturedAt: corpus.capturedAt,
    ranAt: new Date().toISOString(),
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ report, gate: result, provenance }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${renderGateText(result)}\n\n`);

  if (corpus.sanitised) {
    process.stdout.write(
      `Note: the corpus is sanitised; ${corpus.excludedCount} private entries were withheld, ` +
        "so this is a slightly easier retrieval problem than the full local catalog.\n\n",
    );
  }

  if (options.explain) {
    process.stdout.write(`${renderMarkdown(report, result, provenance)}\n`);
    return;
  }

  const { retrieval, decision, stability, latency } = report.aggregate;
  process.stdout.write(
    `recall@K ${retrieval.recallAtK.toFixed(3)} · top1 ${decision.top1Accuracy.toFixed(3)} · ` +
      `noneRecall ${decision.noneRecall.toFixed(3)} · noneF1 ${decision.noneF1.toFixed(3)} · ` +
      `agreement ${stability.agreementRate.toFixed(3)} · p95 ${latency.p95}ms\n` +
      `fixtures ${report.meta.fixtureCount} × ${report.meta.repeat} = ${report.meta.totalRuns} runs\n\n`,
  );
}

/**
 * Measure `recall@K` across skill-quota values without calling the API.
 *
 * Recall depends only on whether the gold capability reaches the shortlist, and the shortlist is
 * built entirely from BM25 and the quota groups. So the most expensive question to answer by
 * brute force — which quota composition retrieves best — is in fact the cheapest one to answer,
 * and it can be swept exhaustively instead of guessed.
 */
function recallOnlyCommand(
  fixtures: readonly ResolvedFixture[],
  entries: readonly CatalogEntry[],
): number {
  const quotas = [4, 6, 8, 10, 14];
  const maxChars = DEFAULT_THRESHOLDS.maxPromptChars;
  const rows: {
    skillQuota: number;
    scorable: number;
    recallAtK: number;
    mrr: number;
    itemCoverage: number;
    meanShortlist: number;
  }[] = [];

  for (const skillQuota of quotas) {
    const groups = quotaGroupsWithSkillLimit(skillQuota, DEFAULT_QUOTA_GROUPS);
    let scorable = 0;
    let hits = 0;
    let reciprocalRankSum = 0;
    let goldItems = 0;
    let goldFound = 0;
    let shortlistTotal = 0;

    for (const fixture of fixtures) {
      if (fixture.expectAbstain) continue;
      scorable += 1;

      const built = buildShortlist(entries, truncatePrompt(fixture.prompt, maxChars), groups);
      const ids = built.entries.map((item) => item.id);
      const present = new Set(ids);
      shortlistTotal += ids.length;

      goldItems += fixture.goldIds.length;
      const found = fixture.goldIds.filter((id) => present.has(id));
      goldFound += found.length;

      if (found.length > 0) {
        hits += 1;
        let bestRank = Number.POSITIVE_INFINITY;
        for (const id of found) bestRank = Math.min(bestRank, ids.indexOf(id));
        reciprocalRankSum += 1 / (bestRank + 1);
      }
    }

    rows.push({
      skillQuota,
      scorable,
      recallAtK: scorable === 0 ? 0 : hits / scorable,
      mrr: scorable === 0 ? 0 : reciprocalRankSum / scorable,
      itemCoverage: goldItems === 0 ? 0 : goldFound / goldItems,
      meanShortlist: scorable === 0 ? 0 : shortlistTotal / scorable,
    });
  }

  rows.sort((a, b) => b.recallAtK - a.recallAtK || b.mrr - a.mrr);

  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ recallByQuota: rows }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write("Recall by skill quota (no API calls)\n\n");
  process.stdout.write("| skillQuota | recall@K | MRR | gold item coverage | mean shortlist |\n");
  process.stdout.write("| --- | --- | --- | --- | --- |\n");
  for (const row of rows) {
    process.stdout.write(
      `| ${row.skillQuota} | ${row.recallAtK.toFixed(3)} | ${row.mrr.toFixed(3)} | ` +
        `${row.itemCoverage.toFixed(3)} | ${row.meanShortlist.toFixed(1)} |\n`,
    );
  }
  process.stdout.write(`\n${rows[0]?.scorable ?? 0} non-abstain fixtures\n`);
  return 0;
}

interface LoadedCorpus {
  entries: CatalogEntry[];
  fingerprint: string;
  capturedAt: string;
  sanitised: boolean;
  excludedCount: number;
}

/**
 * Load the pinned corpus snapshot.
 *
 * Falling back to the live catalog would make a report irreproducible, so a missing snapshot
 * is an error that tells the user how to create one.
 */
function loadEvalCorpus(explicitPath: string | undefined): LoadedCorpus {
  const filePath = explicitPath ?? DEFAULT_CORPUS;
  try {
    const snapshot = loadCorpus(filePath);
    return {
      entries: snapshot.entries,
      fingerprint: snapshot.fingerprint,
      capturedAt: snapshot.capturedAt,
      sanitised: snapshot.sanitised,
      excludedCount: snapshot.excludedCount,
    };
  } catch (error) {
    if (explicitPath !== undefined) throw error;
    throw new Error(
      `No eval corpus at ${DEFAULT_CORPUS}. Create one with:\n` +
        `  skillful eval --snapshot-corpus ${DEFAULT_CORPUS}`,
    );
  }
}

/** Scan the live catalog and write a corpus snapshot. */
async function snapshotCorpus(filePath: string, includePrivate: boolean): Promise<number> {
  const catalog = await scanCatalog({});
  const snapshot = saveCorpus(filePath, catalog.entries, catalog.fingerprint, {
    sanitise: !includePrivate,
  });

  log(`wrote ${snapshot.entries.length} entries to ${filePath}`);
  if (snapshot.sanitised) {
    log(
      `withheld ${snapshot.excludedCount} entries that name private projects. ` +
        "This repository is public; review the file before committing it.",
    );
    if (snapshot.excludedCount === 0) {
      log("warning: nothing was withheld, which is unexpected for a machine with private skills");
    }
  }
  return 0;
}
