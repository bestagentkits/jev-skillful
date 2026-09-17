/**
 * Turning a `RouteResult` into the text a hook injects.
 *
 * Two hard limits live here, and both are cost controls rather than formatting choices.
 * This text enters the agent's context on every prompt it is injected into, so its length is
 * paid for on every turn, and injecting the whole shortlist would reproduce exactly the
 * "enumerate every available skill" pattern that made retrieval necessary in the first place.
 *
 * The cap is therefore one primary plus at most two runner-ups, and the whole message is
 * bounded by a character budget. Nothing in this module throws: an unroutable result renders
 * to `null`, which the caller treats as "inject nothing".
 */

import type { RoutePick, RouteResult } from "../router/route.js";

/** The prefix every injected message carries, so a user can grep for it and remove it. */
export const INJECTION_PREFIX = "[skillful]";

export interface RenderOptions {
  /** Hard cap on runner-ups. The plan fixes this at 2; it is a parameter only for tests. */
  maxRunnersUp?: number;
  /** Hard cap on the rendered message length, including the prefix. */
  maxChars?: number;
}

export const DEFAULT_MAX_RUNNERS_UP = 2;
export const DEFAULT_MAX_CHARS = 480;

/** Collapse to one line and bound the length, so a long description cannot blow the budget. */
function summarise(text: string, limit: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= limit) return oneLine;
  return `${oneLine.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/**
 * Drop a trailing full stop, so the sentence the renderer builds does not end in two.
 *
 * Descriptions are written by skill authors and most of them end in a period, which is correct
 * in their own file and wrong once it is spliced into "Relevant capability: <name> - <text>.".
 * Only the period is removed; a trailing question mark or exclamation is left alone.
 */
function trimFinalPeriod(text: string): string {
  return text.endsWith(".") ? text.slice(0, -1).trimEnd() : text;
}

/** `name — description`, with the description dropped when there is none. */
function label(pick: RoutePick, descriptionLimit: number): string {
  const description = trimFinalPeriod(summarise(pick.description, descriptionLimit));
  return description.length === 0 ? pick.name : `${pick.name} — ${description}`;
}

/**
 * Render the injection for a result, or `null` when there is nothing to inject.
 *
 * Only an `injected` decision renders. A skipped prompt, a degraded route and a result with
 * no primary all render to `null`, because "we could not decide" is not worth spending
 * context on and is not what the user asked for.
 */
export function renderInjection(result: RouteResult, options: RenderOptions = {}): string | null {
  const decision = result.decision;
  if (decision.kind !== "injected") return null;

  const maxRunnersUp = options.maxRunnersUp ?? DEFAULT_MAX_RUNNERS_UP;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  const runnersUp = decision.runnersUp.slice(0, Math.max(0, maxRunnersUp));

  // The primary line gets the room that the runner-up line does not need, so a result with a
  // single capability spends its whole budget describing that one capability.
  const descriptionLimit = runnersUp.length === 0 ? 180 : 140;

  const lines: string[] = [`${INJECTION_PREFIX} Relevant capability: ${label(decision.primary, descriptionLimit)}.`];

  if (runnersUp.length > 0) {
    const names = runnersUp.map((pick) => pick.name).join(", ");
    lines.push(`Also available: ${names}. Ignore if not relevant.`);
  }

  const rendered = lines.join("\n");

  // A message over budget is trimmed by dropping runner-ups before it is truncated mid-word,
  // because a half-sentence of a capability name is worse than not mentioning it.
  if (rendered.length > maxChars && runnersUp.length > 0) {
    const primaryOnly = `${INJECTION_PREFIX} Relevant capability: ${label(decision.primary, descriptionLimit)}.`;
    if (primaryOnly.length <= maxChars) return primaryOnly;
  }

  return rendered.length <= maxChars ? rendered : summarise(rendered, maxChars);
}
