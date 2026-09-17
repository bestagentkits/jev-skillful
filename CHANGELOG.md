# Changelog

## 0.2.0

Telemetry, a local dashboard, and the outcome benchmark harness.

**Telemetry.** The hook writes an append-only local log. Two events: `route` for a decision, and
`capability-used` for a capability an agent actually used. The second exists because without it a
poor outcome cannot be attributed: "the router chose wrong" and "the agent ignored a good suggestion"
need completely different fixes. Correlation happens at read time by session and a time window, so the
hook stays stateless.

The log records a prompt hash and a character count, never prompt text, and never a key or an
environment value. Nothing leaves the machine. A malformed line is skipped rather than fatal, and the
number of skipped lines is reported in the report header and appendix, because silently dropping data
and then presenting statistics from what remains is how a measurement system lies without anyone
intending it. `SKILLFUL_TELEMETRY=0` switches it off.

**Dashboard.** `skillful report` and `skillful dashboard` produce one self-contained HTML file with no
external reference of any kind: no stylesheet link, no script tag, no font, no image. It opens offline
from disk, which is the only environment it is guaranteed to be read in. Six sections.

Sections 5 and 6 are the reason the report is evidence rather than marketing. Section 5 shows RAE, the
aggregate lift, the confidence interval, the four-cell table and the minimum detectable effect.
Section 6 lists the tasks where injection made things worse. Both refuse to invent anything: with no
benchmark they render "not run", because a plausible placeholder number is worse than a blank.

Measured: 50,000 events across 57,143 log lines and 20MB render in 263ms against a 3000ms target.

**Outcome benchmark harness.** Tasks come from SWE-bench Verified rather than being written here,
because a task set invented by the author of the tool tests the author's beliefs about what the tool
should help with. Each task runs in a Docker image pinned to its `base_commit`, with both arms sharing
one environment, and success is decided by the tests and by nothing else.

The analysis is paired: RAE over the invoked subset, McNemar on the discordant pairs, a bootstrap that
resamples tasks rather than runs, and an MDE reported beside the interval. Every formula is tested
against a dataset small enough to compute by hand, including a case where the aggregate lift is
negative while RAE is exactly zero, which is the finding the protocol exists to protect against.

**The benchmark has not been run.** Two of four runtimes cannot complete a headless run: Claude Code's
OAuth session has expired, and Codex's quota resets on 2026-09-19. `pi` and `omp` work. No
`bench-outcome.json` exists, and none was fabricated: a result file with `n = 0` would look like a
measurement and would not be one, and it is the file that decides what this changelog is allowed to
claim.

### What is not claimed

Injecting a suggestion has not been shown to make an agent complete a task better. Nothing has
measured it. Until `bench-outcome.json` exists with a conclusion that supports the claim, this project
claims a routing improvement and makes no claim about task outcomes.

Measurements that do exist: the router retrieves the right capability 82.4% of the time on the
development fixtures and 60.0% on the holdout, against a target of 0.90; abstention works (`noneF1`
0.813); the hook fails open on every error path with a cold route of 1446ms against a 2000ms budget.

### Notes on the numbers

An earlier development-set figure of `recall@K` 0.804 was inflated by a leak: MCP descriptions
contained private service URLs and BM25 matched a server's name out of the URL. Sanitising the corpus
for publication removed the text, and the honest number fell to 0.765 before the `when_to_use`
improvement raised it to 0.824. A retrieval result that depends on a leaked URL is not a result.

## 0.1.0

First public release. The router, the catalog scanner, the four-runtime hook, and the eval harness.
