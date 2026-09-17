/**
 * Route one prompt to at most three capabilities.
 *
 * This is the boundary between phase 2, the runtime hooks in phase 4, and the telemetry in
 * phase 5, so `RouteResult` is a serialisation contract: every field survives a
 * `JSON.stringify` round trip without loss.
 *
 * Nothing here throws. A missing key, an expired budget, an upstream failure and a prompt
 * that needs no capability all come back as a valid result, because a hook that crashes
 * the host agent is worse than a hook that injects nothing.
 */

import type { CatalogEntry, CatalogKind, CatalogRuntime } from "../catalog/types.js";
import { callSystemOne, JevError, type JevClientOptions } from "../jev/client.js";
import { DEFAULT_MODEL, isChoiceAnswer, isNoulAnswer, type SystemOneResponse } from "../jev/types.js";
import { buildShortlist, DEFAULT_QUOTA_GROUPS, type QuotaGroup } from "../retrieval/shortlist.js";
import {
  buildRouteRequest,
  candidateQuestionId,
  NONE_OPTION,
  PRIMARY_QUESTION_ID,
  toCandidate,
} from "./questions.js";
import {
  DEFAULT_THRESHOLDS,
  evaluatePromptHeuristics,
  truncatePrompt,
  type RouteThresholds,
} from "./thresholds.js";

/** A second installed copy of the same capability, for a different runtime root. */
export interface RouteAlternate {
  runtime: CatalogRuntime;
  sourcePath: string;
}

/** A capability selected for injection. Carries enough to render and to locate it. */
export interface RoutePick {
  id: string;
  kind: CatalogKind;
  name: string;
  description: string;
  sourcePath: string;
  /**
   * Other runtime roots that hold an indistinguishable copy of this same capability.
   *
   * The hook in phase 4 runs inside one specific runtime, so it prefers its own runtime's
   * path and falls back to the primary `sourcePath`.
   */
  alternates: RouteAlternate[];
}

export interface RouteRankedPick extends RoutePick {
  /** Probability that this capability should be loaded, from its `noul` question. */
  noul: number;
}

/**
 * Why routing produced nothing.
 *
 * `heuristic` covers the checks that never reach the network; `detail` names which one.
 * `none-won` means the model chose `none` or gave it at least `noneThreshold`. The third
 * is reserved for a winner the model was not confident about.
 */
export type SkipReason = "heuristic" | "none-won" | "below-threshold" | "empty-shortlist";

/** Why routing could not complete. Mirrors `JevErrorCode`. */
export type DegradedReason = "timeout" | "auth" | "upstream" | "network" | "malformed" | "config";

export type RouteDecision =
  | {
      kind: "injected";
      primary: RoutePick;
      runnersUp: RouteRankedPick[];
      confidence: number;
      noneP: number;
    }
  | { kind: "skipped"; reason: SkipReason; detail?: string }
  | { kind: "degraded"; reason: DegradedReason; detail?: string };

export interface RouteResult {
  decision: RouteDecision;
  /** Candidate ids sent to the model, in shortlist order. */
  shortlist: string[];
  /** BM25 score per shortlisted candidate. Explain output only. */
  shortlistDetail: { id: string; kind: CatalogKind; score: number }[];
  /** Probability that the winning option was `none`. Absent when no answer was parsed. */
  primary?: { id: string; noneP: number; confidence: number; probability: number };
  /** Per-candidate `noul` values, best first. */
  ranking: { id: string; noul: number }[];
  latencyMs: number;
  tokensIn?: number;
  tokensOut?: number;
  cacheHit: boolean;
  promptChars: number;
  model: string;
}

export interface RouteOptions {
  /** The catalog to route against. */
  entries: readonly CatalogEntry[];
  thresholds?: Partial<RouteThresholds>;
  quotaGroups?: readonly QuotaGroup[];
  model?: string;
  /**
   * When false, only the catalog is sent and the prompt text is withheld.
   *
   * The user's prompt still determines the shortlist locally, so this trades retrieval
   * quality for not transmitting the prompt at all.
   */
  uploadPrompt?: boolean;
  /** Jev client overrides. Tests inject `fetchImpl` and `sleepImpl` here. */
  jev?: JevClientOptions;
  /** Clock injection so tests do not depend on wall time. */
  now?: () => number;
  /** Abort signal forwarded to the Jev client, for callers with their own deadline. */
  signal?: AbortSignal;
}

/** Smallest budget worth attempting a request with. */
const MIN_ATTEMPT_BUDGET_MS = 200;

/** Translate a thrown error into the degraded reason reported to the caller. */
function degradedFrom(error: unknown): { reason: DegradedReason; detail: string } {
  if (error instanceof JevError) {
    return { reason: error.code, detail: error.message };
  }
  const name = error instanceof Error ? error.name : "unknown";
  return { reason: "upstream", detail: `Unexpected routing failure (${name})` };
}

/**
 * Route one prompt.
 *
 * The overall budget is enforced with an abort signal rather than only by trimming the
 * per-attempt timeout, so a retry sequence cannot overrun the ceiling it was given. The
 * abort surfaces as a `timeout` result.
 */
export async function route(prompt: string, options: RouteOptions): Promise<RouteResult> {
  const thresholds: RouteThresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const now = options.now ?? Date.now;
  const startedAt = now();
  const model = options.model ?? DEFAULT_MODEL;
  const promptChars = prompt.length;

  const shortlist: string[] = [];
  const shortlistDetail: RouteResult["shortlistDetail"] = [];
  const ranking: RouteResult["ranking"] = [];

  const finish = (decision: RouteDecision, extra: Partial<RouteResult> = {}): RouteResult => {
    return {
      decision,
      shortlist,
      shortlistDetail,
      ranking,
      latencyMs: now() - startedAt,
      cacheHit: false,
      promptChars,
      model,
      ...extra,
    };
  };

  const heuristic = evaluatePromptHeuristics(prompt, thresholds);
  if (heuristic.skip) {
    return finish({ kind: "skipped", reason: "heuristic", detail: heuristic.reason });
  }

  const built = buildShortlist(options.entries, prompt, options.quotaGroups ?? DEFAULT_QUOTA_GROUPS);
  for (const entry of built.entries) {
    shortlist.push(entry.id);
    shortlistDetail.push({ id: entry.id, kind: entry.kind, score: entry.score });
  }

  if (built.entries.length === 0) {
    return finish({ kind: "skipped", reason: "empty-shortlist" });
  }

  const candidates = built.entries.map((entry) => toCandidate(entry.entry));
  const byId = new Map(built.entries.map((entry) => [entry.id, entry.entry]));
  const alternatesById = new Map(
    built.entries.map((entry) => [entry.id, entry.alternates] as const),
  );

  const taskText =
    options.uploadPrompt === false
      ? "(prompt withheld; select only from the listed capabilities)"
      : truncatePrompt(prompt, thresholds.maxPromptChars);

  const request = buildRouteRequest(taskText, candidates);

  const budgetLeft = thresholds.budgetMs - (now() - startedAt);
  if (budgetLeft < MIN_ATTEMPT_BUDGET_MS) {
    return finish({ kind: "degraded", reason: "timeout", detail: "Budget consumed before request" });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, budgetLeft);

  let response: SystemOneResponse;
  try {
    response = await callSystemOne(
      { state: request.state, model, questions: request.questions },
      {
        ...options.jev,
        requestTimeoutMs: Math.min(thresholds.requestTimeoutMs, budgetLeft),
        signal: controller.signal,
      },
    );
  } catch (error) {
    const degraded = degradedFrom(error);
    return finish({ kind: "degraded", reason: degraded.reason, detail: degraded.detail });
  } finally {
    clearTimeout(timer);
  }

  const usage = response.usage;
  const extras: Partial<RouteResult> = {};
  if (usage?.input_tokens !== undefined) extras.tokensIn = usage.input_tokens;
  if (usage?.output_tokens !== undefined) extras.tokensOut = usage.output_tokens;

  // Ranking is built before the decision so that `--explain` always shows the full
  // ordering, including when the decision turns out to be "inject nothing".
  candidates.forEach((candidate, index) => {
    const answer = response.answers[candidateQuestionId(index)];
    if (isNoulAnswer(answer)) {
      ranking.push({ id: candidate.id, noul: answer.noul });
    }
  });
  ranking.sort((x, y) => (y.noul - x.noul) || (x.id < y.id ? -1 : 1));

  const primaryAnswer = response.answers[PRIMARY_QUESTION_ID];
  if (!isChoiceAnswer(primaryAnswer)) {
    return finish(
      { kind: "degraded", reason: "malformed", detail: "Response contained no usable primary answer" },
      extras,
    );
  }

  const noneP = primaryAnswer.probabilities[NONE_OPTION] ?? (primaryAnswer.choice === NONE_OPTION ? 1 : 0);
  const probability = primaryAnswer.probabilities[primaryAnswer.choice] ?? 0;

  if (primaryAnswer.choice === NONE_OPTION || noneP >= thresholds.noneThreshold) {
    return finish({ kind: "skipped", reason: "none-won" }, extras);
  }

  const winner = byId.get(primaryAnswer.choice);
  if (winner === undefined) {
    return finish(
      {
        kind: "degraded",
        reason: "malformed",
        detail: `Model chose an option that was not offered: ${primaryAnswer.choice}`,
      },
      extras,
    );
  }

  // A winner the model was unsure about is where injection is more likely to mislead than
  // help. The floor is its own threshold rather than `noneThreshold`: with sixteen options on
  // the ballot, a clearly-best answer often carries well under half the probability, and the
  // baseline run showed a 0.5 floor discarding correct picks.
  if (probability < thresholds.minWinnerProbability) {
    return finish(
      {
        kind: "skipped",
        reason: "below-threshold",
        detail: `Winning probability ${probability.toFixed(3)} is below ${thresholds.minWinnerProbability}`,
      },
      { ...extras, primary: { id: winner.id, noneP, confidence: primaryAnswer.confidence, probability } },
    );
  }

  const runnersUp: RouteRankedPick[] = [];
  for (const ranked of ranking) {
    if (runnersUp.length >= thresholds.maxRunnersUp) break;
    if (ranked.id === winner.id) continue;
    if (ranked.noul < thresholds.runnerUpThreshold) continue;
    const entry = byId.get(ranked.id);
    if (entry === undefined) continue;
    runnersUp.push({ ...toPick(entry, alternatesById.get(ranked.id) ?? []), noul: ranked.noul });
  }

  return finish(
    {
      kind: "injected",
      primary: toPick(winner, alternatesById.get(winner.id) ?? []),
      runnersUp,
      confidence: primaryAnswer.confidence,
      noneP,
    },
    { ...extras, primary: { id: winner.id, noneP, confidence: primaryAnswer.confidence, probability } },
  );
}

function toPick(entry: CatalogEntry, alternates: readonly RouteAlternate[]): RoutePick {
  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    description: entry.description,
    sourcePath: entry.sourcePath,
    alternates: [...alternates],
  };
}
