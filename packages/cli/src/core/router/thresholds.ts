/**
 * Route thresholds and the prompt heuristics that avoid a network call entirely.
 *
 * Every number here is a starting value measured on a handful of prompts, not a tuned
 * one. Phase 3 owns the tuning, using the eval harness; these defaults exist so the
 * router has defined behaviour before that harness exists.
 */

export interface RouteThresholds {
  /**
   * If `none` wins, or its probability reaches this, nothing is injected.
   */
  noneThreshold: number;
  /**
   * Floor on the winning option's probability, separate from `noneThreshold`.
   *
   * These were one number at first, and the baseline run showed why that was wrong. A `choice`
   * over sixteen options routinely gives a clearly-best answer less than half the probability,
   * so a 0.5 floor rejected correct picks as `below-threshold`: five fixtures had the right
   * answer chosen by the model and thrown away. Whether `none` should win and how confident a
   * winner must be are different questions with different costs.
   */
  minWinnerProbability: number;
  /** Minimum `noul` for a candidate to be offered as a runner-up. */
  runnerUpThreshold: number;
  /** Upper bound on runner-ups. The primary is not counted. */
  maxRunnersUp: number;
  /** Prompts shorter than this are never routed. */
  minPromptChars: number;
  /** Hard ceiling on the whole routing path, including retries. */
  budgetMs: number;
  /** Prompts are truncated to this before leaving the machine. */
  maxPromptChars: number;
  /** Timeout for a single HTTP attempt to TypeSafe. */
  requestTimeoutMs: number;
}

export const DEFAULT_THRESHOLDS: RouteThresholds = {
  noneThreshold: 0.5,
  minWinnerProbability: 0.25,
  runnerUpThreshold: 0.6,
  maxRunnersUp: 2,
  minPromptChars: 12,
  budgetMs: 2000,
  maxPromptChars: 1000,
  requestTimeoutMs: 1800,
};

/**
 * Prompts that are complete messages on their own.
 *
 * Matched against the whole prompt after normalisation, never as a substring: `thanks`
 * is a social turn, while `thanks, now fix the parser` is a task and must be routed.
 */
const STALL_PROMPTS: ReadonlySet<string> = new Set([
  "thanks",
  "thank you",
  "thanks!",
  "ty",
  "thx",
  "ok",
  "okay",
  "k",
  "cool",
  "nice",
  "great",
  "perfect",
  "awesome",
  "lgtm",
  "looks good",
  "looks good to me",
  "hi",
  "hello",
  "hey",
  "yo",
  "good morning",
  "good night",
  "bye",
  "cheers",
  "nope",
  "yep",
  "yeah",
  "yes",
  "no",
  "sure",
  "got it",
  "understood",
  "continue",
  "go on",
  "next",
  "done",
  "stop",
  "carry on",
  "keep going",
  "proceed",
]);

export type SkipReason = "too-short" | "stall" | "slash-command";

export interface PromptHeuristicResult {
  /** True when routing should not happen. */
  skip: boolean;
  reason?: SkipReason;
}

/** Lowercase, collapse whitespace, strip surrounding punctuation used for emphasis. */
function normalisePrompt(prompt: string): string {
  return prompt.trim().toLowerCase().replace(/\s+/g, " ").replace(/^[!.…\s]+|[!.…\s]+$/g, "");
}

/**
 * Decide whether a prompt is worth routing, without any network call.
 *
 * Three checks, in order: a slash command is the user asking for a specific capability by
 * name and already resolved; a very short prompt has too little signal for BM25; a stall
 * prompt is a complete social turn.
 */
export function evaluatePromptHeuristics(
  prompt: string,
  thresholds: Pick<RouteThresholds, "minPromptChars"> = DEFAULT_THRESHOLDS,
): PromptHeuristicResult {
  const trimmed = prompt.trim();

  if (trimmed.startsWith("/")) {
    return { skip: true, reason: "slash-command" };
  }
  if (trimmed.length < thresholds.minPromptChars) {
    return { skip: true, reason: "too-short" };
  }
  if (STALL_PROMPTS.has(normalisePrompt(trimmed))) {
    return { skip: true, reason: "stall" };
  }
  return { skip: false };
}

/** Truncate a prompt to the configured ceiling without splitting a surrogate pair. */
export function truncatePrompt(prompt: string, maxChars: number): string {
  if (prompt.length <= maxChars) return prompt;
  let cut = prompt.slice(0, maxChars);
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return cut;
}
