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
export function toCandidate(entry: CatalogEntry, limit = MAX_CANDIDATE_DESCRIPTION_CHARS): Candidate {
  const description = entry.description.length > limit
    ? `${entry.description.slice(0, limit - 1).trimEnd()}…`
    : entry.description;

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
      "No listed capability is needed. Choose this for small talk, for a task the agent can already do with the context it has, or when none of the listed capabilities would help.",
  };

  for (const candidate of candidates) {
    const label = candidate.description.length > 0 ? candidate.description : candidate.name;
    criteria[candidate.id] = `[${candidate.kind}] ${label}`;
  }

  return {
    type: "choice",
    instructions:
      "Which single capability, if any, should be loaded before answering the task? Choose the capability that would most change how the task is done. Choose `none` when the task needs no capability from the list.",
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
