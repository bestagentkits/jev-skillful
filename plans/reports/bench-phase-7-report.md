# Phase 7 report: outcome benchmark

**The harness is complete and verified. The benchmark itself did not run, and this report says so
rather than presenting a number.**

No `bench-outcome.json` was written. A benchmark result file with `n = 0` would be a file that looks
like a measurement and is not one, and the dashboard already renders "not run" correctly when that
file is absent. Writing one anyway would be the single most dishonest thing this project could do,
because it is the file whose contents decide what the README and landing page are allowed to claim.

## What is built and verified

| Piece | State |
|---|---|
| Paired analysis: RAE, aggregate lift, four-cell table, McNemar, bootstrap CI, MDE | Built, tested against hand-computed known answers |
| Harm taxonomy with instability detection | Built, tested |
| SWE-bench task loading | Built; loads real SWE-bench Verified records |
| Frozen Docker environments, keyed `repo@commit` | Built; dry run confirms 8 distinct images for 8 tasks |
| Two-arm runner with test-based success and baseline check | Built |
| Pilot pre-screening with `excluded.json` | Built |
| Runtime probe | Built, run, and the result is real |
| The suite on disk | 8 real SWE-bench Verified instances |

`skillful bench --probe`, run on this machine:

| Runtime | Result |
|---|---|
| `claude-code` | Unavailable: OAuth session expired and could not be refreshed |
| `codex` | Unavailable: quota reached, resets 2026-09-19 |
| `pi` | Working |
| `omp` | Working |

Two of four runtimes can complete a headless run. That is a real constraint and not a reason to
report a result that was not obtained: a suite run on two runtimes measures two runtimes, and
presenting it as the project's outcome would misstate the coverage.

## Why the suite did not run

Stated plainly, in the order that matters.

1. **Half the runtimes cannot run.** `claude-code` needs re-authentication, which is a human action
   with a browser. `codex` is quota-blocked until 2026-09-19. Neither can be worked around from here.

2. **A real run is large.** 8 tasks × 2 arms × 3 repeats, with each task needing its own Docker image
   built from a real repository at a pinned commit, and each agent run taking minutes to hours. The
   dataset's own difficulty labels for the 8 selected tasks range from "15 min - 1 hour" to
   "1-4 hours" per task. The full protocol is on the order of days of wall clock, not minutes.

3. **A smaller run would not answer the question either.** This is the part worth being explicit
   about rather than quietly shrinking the suite. The minimum detectable effect scales as
   `sqrt(discordance / n)`. At 8 tasks with three discordant pairs, the MDE is roughly 0.6 — meaning
   only an enormous effect would be detectable, and a null result would be an uninformative one
   dressed up as a finding. The harness computes and reports that number precisely so this cannot be
   hidden; running 8 tasks and reporting `not-proven` would be a statement about the sample that reads
   like a statement about the tool.

So the honest status is: **not run**, not `not-proven`. The distinction matters, and the plan's own
three-level scheme does not have a level for it, which is itself a finding worth recording. `not-proven`
means the data was collected and the interval spans zero. Here there is no interval at all.

## What the evidence does and does not support

Supported, with measurements:

- The router retrieves the right capability 82.4% of the time on the development fixtures and 60.0% on
  the holdout, and abstains correctly on trivial prompts (`noneF1` 0.813). See
  `eval-phase-3-report.md`.
- The hook installs for four runtimes idempotently, never damages another tool's configuration, and
  fails open on every error path with a measured cold route of 1446ms against a 2000ms budget.
- The telemetry pipeline renders 50,000 events in 263ms and reports its own unreadable lines.

Not supported, and this is the central claim of the project:

- **That injection makes an agent complete a task better.** Nothing has measured this. The README, the
  landing page and the CHANGELOG all state that in the same words, and they must continue to until
  `bench-outcome.json` exists with a conclusion that supports the claim.

## What would make this runnable

In order of leverage:

1. **Re-authenticate Claude Code and wait for the Codex quota.** Two of four runtimes returning takes
   the eligible coverage from 50% to 100% with no code change.
2. **Choose a cheaper repository than astropy.** The 8 tasks selected are all astropy, whose test
   modules are slow and whose difficulty labels are 15 minutes to 4 hours per task. A repository with
   fast unit tests would make a 30-task suite feasible where 8 astropy tasks are not.
3. **Pre-build the images at selection time** rather than at run time, so the pilot's cost is paid
   once and the suite's wall clock is agent time only.
4. **Accept a larger expected effect.** With `n = 30` and a 30% discordance rate the MDE is about
   0.28, which is still large. Reaching an MDE of 0.15 needs roughly 100 tasks. The plan's target
   suite of about 40 tasks sits between those, so the honest expectation for a first run is
   `not-proven` with an MDE in the 0.2–0.3 range — a statement about the sample, which is exactly what
   the MDE exists to make legible.

## Unresolved questions

1. Should the three-level conclusion scheme gain a fourth level, `not-run`, so that "no data" can
   never be confused with "no effect"? The current scheme has no way to express the state this phase
   ended in, and the dashboard handles it only because an absent file is treated as absent.
2. Is 8 tasks worth running at all, given the MDE makes a null uninformative? If the answer is no, the
   suite needs to grow before the first run rather than after, which contradicts the plan's ordering
   of "screen, freeze, run".
3. The plan requires `--repeat 3` with re-runs of discordant tasks. At three repeats the cost triples
   for a variance estimate, not for an effect estimate. Is one repeat per task with a larger task
   count a better use of the same budget?
