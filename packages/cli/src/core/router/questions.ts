/**
 * Build the single System One request that decides routing.
 *
 * One `choice` question carries the decision and one `noul` question per candidate
 * carries the runner-up ranking. The `noul` questions are speculative for every candidate
 * except the winner, which is the documented and supported way to ask about branches you
 * may not need: questions are evaluated in parallel against the same state, so the extra
 * ones cost tokens but no meaningful time.
 */

import type { Question } from "../jev/types.js";
import type { CatalogEntry, CatalogKind } from "../catalog/types.js";

/** Option name that means "no capability fits". */
export const NONE_OPTION = "none";

/** Question id for the primary decision. Ids are never sent to the model. */
export const PRIMARY_QUESTION_ID = "primary";

/** Prefix for the per-candidate `noul` question ids. */
export const CANDIDATE_QUESTION_PREFIX = "c";

/**
 * Maximum description characters placed in the request.
 *
 * Descriptions are already bounded when the catalog is built, but the shortlist can be
 * assembled from other sources, and this keeps one very long description from dominating
 * the request.
 */
export const MAX_CANDIDATE_DESCRIPTION_CHARS = 200;

export interface Candidate {
  id: string;
  kind: CatalogKind;
  name: string;
  description: string;
}

/** Reduce a catalog entry to what the request actually needs. */
/**
 * Reduce a catalog entry to what the request actually needs.
 *
 * The routing-intent text is folded into the description rather than carried as a separate
 * field, because to the model they are one question — what does this help with, and when. One
 * combined string also means one length bound applies.
 */
export function toCandidate(entry: CatalogEntry, limit = MAX_CANDIDATE_DESCRIPTION_CHARS): Candidate {
  const combined = [entry.description, entry.whenToUse ?? ""]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ");

  const description = combined.length > limit
    ? `${combined.slice(0, limit - 1).trimEnd()}…`
    : combined;

  return { id: entry.id, kind: entry.kind, name: entry.name, description };
}

/** The structured state the model evaluates. */
export interface RouteState {
  task: string;
  candidates: { id: string; kind: CatalogKind; name: string; description: string }[];
}

export function buildRouteState(task: string, candidates: readonly Candidate[]): RouteState {
  return {
    task,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      kind: candidate.kind,
      name: candidate.name,
      description: candidate.description,
    })),
  };
}

/**
 * One `choice` question over every candidate plus `none`.
 *
 * `none` is inserted **first** on purpose. The criteria map is sent to the model in key
 * order, and a trailing "none of the above" option is a known way to bias a model toward
 * the options that preceded it. Phase 3 measures whether this ordering actually matters.
 */
export function buildPrimaryQuestion(candidates: readonly Candidate[]): Question {
  const criteria: Record<string, string | null> = {
    [NONE_OPTION]:
      "No listed capability is needed. Choose this for small talk, for a short or local edit the agent can already make with the context it has, for a question about the current code that can be answered by reading it, and for anything the listed capabilities would not concretely help with.",
  };

  for (const candidate of candidates) {
    // The label carries the name as well as the description. A name is often the strongest
    // signal available — `agent-brain` says what it is, while its description is the
    // infrastructure string the catalog found in a config file — and omitting it left the
    // model choosing between opaque ids with nothing to go on.
    const label = candidate.description.length > 0
      ? `${candidate.name} — ${candidate.description}`
      : candidate.name;
    criteria[candidate.id] = `[${candidate.kind}] ${label}`;
  }

  return {
    type: "choice",
    instructions:
      "Which single capability, if any, should be loaded before answering the task? Choose the capability that would most change how the task is done. Prefer `none` when the task is small, local, or already answerable from the context the agent has.",
    criteria,
  };
}

/**
 * One `noul` question per candidate, referencing the candidate by index in the state.
 *
 * The question is phrased so that a high value means "yes, load this", because a `noul`
 * answer has no separate confidence and its meaning has to be unambiguous on its own.
 */
export function buildCandidateQuestion(index: number): { id: string; question: Question } {
  return {
    id: `${CANDIDATE_QUESTION_PREFIX}${index}`,
    question: {
      type: "noul",
      instructions: `Should the capability at state.candidates[${index}] be loaded for this task? Answer yes only if loading it would concretely help.`,
    },
  };
}

export interface BuiltRequest {
  state: RouteState;
  questions: Record<string, Question>;
  /** Candidate id by question id, so answers can be mapped back. */
  questionToCandidate: Map<string, string>;
}

/** Assemble the full question map for one routing request. */
export function buildRouteRequest(task: string, candidates: readonly Candidate[]): BuiltRequest {
  const questions: Record<string, Question> = {
    [PRIMARY_QUESTION_ID]: buildPrimaryQuestion(candidates),
  };
  const questionToCandidate = new Map<string, string>();

  candidates.forEach((candidate, index) => {
    const built = buildCandidateQuestion(index);
    questions[built.id] = built.question;
    questionToCandidate.set(built.id, candidate.id);
  });

  return { state: buildRouteState(task, candidates), questions, questionToCandidate };
}

/** Question id for the `noul` question about the candidate at `index`. */
export function candidateQuestionId(index: number): string {
  return `${CANDIDATE_QUESTION_PREFIX}${index}`;
}
