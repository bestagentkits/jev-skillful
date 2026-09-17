/**
 * Wire types for the TypeSafe System One endpoint.
 *
 * These mirror the published request and response shapes exactly. The distinction that
 * matters most for routing is that `noul` returns a bare probability with **no separate
 * confidence**, while `choice` returns a distribution plus a confidence. Runner-up
 * ranking therefore uses the `noul` value directly, and only the primary decision has a
 * confidence to report.
 */

/** Yes/no question. High means yes. */
export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /** Option name to description. `null` when the option name is self-explanatory. */
  criteria: Record<string, string | null>;
}

export type Question = NoulQuestion | ChoiceQuestion;

export interface SystemOneRequest {
  /** The content to evaluate. A string or structured data. */
  state: unknown;
  /** Required by the API. `jev-latest` is the flagship alias. */
  model: string;
  questions: Record<string, Question>;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer;

export interface SystemOneResponse {
  model: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Default model alias. Verified against the live API. */
export const DEFAULT_MODEL = "jev-latest";

export const DEFAULT_BASE_URL = "https://api.typesafe.ai/v1/systemone";

/** Environment variable read for the API key. Never accepted as a CLI flag. */
export const API_KEY_ENV = "TYPESAFE_API_KEY";

export function isNoulAnswer(answer: Answer | undefined): answer is NoulAnswer {
  return answer !== undefined && answer.type === "noul";
}

export function isChoiceAnswer(answer: Answer | undefined): answer is ChoiceAnswer {
  return answer !== undefined && answer.type === "choice";
}
