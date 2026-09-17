/**
 * What a hook injects when it cannot resolve anything.
 *
 * The rule this module exists to enforce: a hook never fails the prompt and never prints an
 * error into the agent's terminal. A user whose key expired, whose network is down, or whose
 * configuration is wrong should get a working agent that quietly lacks a suggestion, not a
 * stack trace on every turn.
 *
 * The reminder is deliberately short and phrased as an escape hatch rather than as an error,
 * because in the common case the honest description is "this prompt did not need a
 * capability", which is not a failure at all.
 */

import type { DegradedReason, SkipReason } from "../router/route.js";

/**
 * Human-readable cause per degraded reason.
 *
 * These are for `doctor`, not for injection. The injected text is the same in every case
 * because the user's next action is the same in every case.
 */
const CAUSE: Record<DegradedReason, string> = {
  timeout: "the routing budget was exhausted",
  auth: "the API key is missing or rejected",
  upstream: "the routing service returned an error",
  network: "the routing service could not be reached",
  malformed: "the routing service returned an unreadable response",
  config: "the local configuration is invalid",
};

export function describeDegraded(reason: DegradedReason): string {
  return CAUSE[reason];
}

/**
 * The single line injected when routing did not produce a decision.
 *
 * Kept to one line on purpose. This text is paid for on every prompt it appears in, and a
 * degraded route is already a case where we know nothing useful about the task.
 */
export const DEGRADED_REMINDER =
  "[skillful] Could not resolve a capability suggestion. If this task needs a specialist skill or MCP server, run: npx @mrgoonie/skillful";

/** The reminder text to inject for a reason that prevented a decision. */
export function degradedReminder(): string {
  return DEGRADED_REMINDER;
}

/** True when a skip reason is a normal outcome rather than a problem worth surfacing. */
export function isBenignSkip(reason: SkipReason): boolean {
  // `heuristic`, `none-won` and `empty-shortlist` are all "this prompt did not need a
  // capability" or "there was nothing to choose from". Neither is worth any context. Only
  // `below-threshold` describes a decision that was made and then discarded, and even that
  // injects nothing: the discarded pick is not information the agent needs.
  return reason === "heuristic" || reason === "none-won" || reason === "empty-shortlist" || reason === "below-threshold";
}
