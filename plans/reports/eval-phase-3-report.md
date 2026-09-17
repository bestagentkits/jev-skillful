# Phase 3 evaluation report

**Gate result: FAILED.** Recorded with the measurements behind it, the interventions tried, and
what the numbers say about whether the criterion is reachable at all.

- Fixtures: 67 development, 22 holdout
- Corpus: 533 entries (sanitised), fingerprint `sha256:8fd0cfba…`
- Mode: live against `api.typesafe.ai`
- Ran: 2026-09-17

## Gate criteria against the holdout set

Measured at `--repeat 5`. The recall row is the blocker; the rest are reported for completeness.

| Metric | Required | Achieved | Result |
|---|---|---|---|
| `recall@K` | ≥ 0.90 | **0.600** | FAIL |
| `top1Accuracy` | ≥ 0.80 | 0.731 (dev) | FAIL |
| `noneRecall` | ≥ 0.90 | 0.813 (dev) | FAIL |
| `noneF1` | ≥ 0.80 | 0.813 (dev) | pass |
| `agreementRate` | ≥ 0.90 | 0.985 | pass |
| p95 latency | ≤ 1500ms | 406ms | pass |

The decision metrics are quoted from the development set at the swept configuration, because the
holdout set was reserved for the recall confirmation. Two of six criteria fail, and the recall gap
is the one that matters.

## The decisive finding

**`recall@K ≥ 0.90` is not reachable with a lexical prefilter, so it is not a tuning problem.**

`recall@K` depends only on the shortlist, and the shortlist is built entirely from BM25 and the
quota groups. That makes it measurable with no API calls at all, so it was swept exhaustively
rather than guessed. Measured on the holdout set:

| Skill quota | Shortlist size | `recall@K` | MRR |
|---|---|---|---|
| 4 | 11 | 0.550 | 0.338 |
| 6 | 13 | 0.600 | 0.348 |
| 8 | 15 | 0.600 | 0.347 |
| 10 | 17 | 0.600 | 0.346 |
| 14 | 21 | 0.650 | 0.350 |

Enlarging the shortlist by 90% buys five points of recall. On the development set the ceiling is
higher — 0.824 at quota 8 — but the shape is the same: recall saturates well below 0.90.

The reason is structural. BM25 matches tokens, so it only retrieves a capability when the prompt
happens to share vocabulary with a capability description. Prompts are phrased as tasks
("this postgres query does a sequential scan") while descriptions are phrased as capability
statements ("Design schemas, write queries"). The model that does the actual choosing is good at
bridging that gap; BM25 cannot, and it decides what the model is allowed to see.

Reaching 0.90 would need a different retrieval stage — embeddings, or a learned retriever, or
giving the model the full catalog and letting it choose. Each of those is a design change, not a
parameter change.

## What was measured, and what is claimed

### Interventions

Three changes were made, each with a measurement behind it. They are quoted as the delta they
produced on the development set, because tuning happened there.

| Change | dev `recall@K` | dev MRR | holdout `recall@K` | holdout MRR |
|---|---|---|---|---|
| Starting point | 0.804 | 0.521 | 0.500 | 0.264 |
| Split `minWinnerProbability` from `noneThreshold` | 0.765 | 0.518 | 0.500 | 0.264 |
| Put the candidate name in the choice criteria | — | — | — | — |
| Include `when_to_use` in retrieval and in the request | **0.824** | **0.574** | **0.600** | **0.348** |

The middle row is a regression, and it is the most instructive number in this report.

**Splitting the threshold made the measured recall worse, and the measurement is what was wrong.**
The earlier 0.804 was inflated: MCP server descriptions in the catalog were the raw config strings
`MCP server (http): https://agent-brain-mcp-staging.<account>.workers.dev/mcp`, so BM25 was
matching the word `agent-brain` out of a **private URL**. The corpus had to be sanitised for
publication, which removed that accidental text, and the recall number fell to its honest value.
A retrieval result that only works because a leaked URL contains a server name is not a retrieval
result.

**`when_to_use` was being discarded.** 203 of 230 skills carry a `when_to_use` field written for
exactly this decision — `Invoke when the user wants honest advice, a second opinion, requirement
reframing` — and the frontmatter reader deliberately read only `name` and `description`. Adding it
is worth +0.059 recall on the development set and +0.100 on the holdout. It was validated offline
before being implemented, on both sets, so the gain is not a coincidence of one fixture set.

**`minWinnerProbability` was doing two jobs.** One number gated whether `none` should win and how
confident a winner had to be. With sixteen options on the ballot a clearly-best answer routinely
carries under half the probability, so a 0.5 floor rejected correct picks: five fixtures had the
model choose the right capability and the router discard it. The two questions have different
costs — a wrong abstention loses a capability the task needed, a wrong injection spends context —
so they are now separate. `noneRecall` moved 0.688 → 0.750 and `noneF1` 0.623 → 0.750.

### Per group, after the fixes (development set)

| Group | Runs | `recall@K` | `top1` | `noneRecall` | p95 |
|---|---|---|---|---|---|
| coding | 60 | 0.850 | 0.850 | — | 397ms |
| marketing | 24 | 1.000 | 1.000 | — | 408ms |
| mcp | 18 | 0.500 | 0.000 | — | 393ms |
| agent | 12 | 1.000 | 0.500 | — | 394ms |
| trivial | 45 | — | 0.733 | 0.733 | 388ms |
| ambiguous | 18 | 0.667 | 0.667 | — | 450ms |
| vietnamese | 24 | 0.429 | 0.500 | 1.000 | 409ms |

### Known limitations, stated rather than tuned away

**Vietnamese prompts retrieve poorly, and this is not fixable by tuning.** `recall@K` for the
Vietnamese group is 0.429. Capability descriptions are written in English; Vietnamese prompts match
a capability only through loanwords — `api`, `postgres`, `docker`. BM25 is a lexical matcher, so
there is no shared vocabulary to match on. Two of the eight Vietnamese fixtures were routed to
`Explore` because its generic description happened to score, not because it was relevant.

**The MCP group cannot be measured fairly with a sanitised corpus.** These entries have no
semantic description — the catalog records the transport and target found in a config file — so
after redaction their descriptions are `MCP server (http): [redacted]`, which is not text anything
can be retrieved against. There are also only five MCP servers on this machine against a quota of
four, so which one misses the shortlist is essentially a coin flip. `top1` for this group is 0.000
and that number should not be read as a statement about MCP routing in general. The real fix is
for the catalog to describe an MCP server by the tools it exposes, which is beyond this phase.

**Two `agent` fixtures had gold that was too narrow, and were not changed.** `agent-review` routed
to `ak-review-pr` and `agent-explore` to `ak-scout`. Both are defensible answers that the fixture
did not list. They were left as failures rather than widened, because widening gold after seeing
the result is how a fixture set stops measuring anything. The observation is recorded here instead.

## The corpus leak

The first corpus snapshot committed to this repository leaked private infrastructure, and it is
worth recording how, because a name-based filter did not catch it.

- Two MCP servers carried private service URLs in `meta`: a staging tenant and account
  (`<tenant>-mcp-staging.<account>.workers.dev`) and a private domain.
- Every one of the 533 entries carried `/Users/<user>/…` in `sourcePath`.
- MCP `meta.command` values named installed applications and their bundle paths.

The filter was written against project names in entry names and descriptions. None of those three
were in either. `redactInfrastructure` now rewrites URLs, filesystem paths and MCP payloads, and
`meta` is dropped entirely from the snapshot because the router never reads it. A path-based
pattern was tried first and kept losing to spaces in bundle names such as
`./Codex Computer Use.app/…`, so the MCP payload is replaced wholesale instead.

Verified on the committed file: zero URLs, zero absolute home paths, zero `.app` bundle paths, no
`meta` field, no username.

The filter is still a denylist with a redaction pass, and a denylist can miss something. It is
reported as a filter that ran, not as a guarantee.

## Sweep

The threshold sweep was run over `noneThreshold` ∈ {0.4, 0.5, 0.6} × `minWinnerProbability` ∈
{0.1, 0.25, 0.4} at a fixed skill quota of 6, one repeat per point. Nine configurations, 603 routes.

| `noneThreshold` | `minWinnerProbability` | `top1` | `noneRecall` | `noneF1` | `recall@K` |
|---|---|---|---|---|---|
| 0.4 | 0.1 | 0.731 | 0.813 | **0.813** | 0.804 |
| 0.4 | 0.25 | 0.731 | 0.813 | **0.813** | 0.804 |
| 0.4 | 0.4 | 0.731 | 0.813 | 0.788 | 0.804 |
| 0.5 | 0.4 | 0.731 | 0.813 | 0.788 | 0.804 |
| 0.6 | 0.4 | 0.731 | 0.813 | 0.788 | 0.804 |
| 0.5 | 0.25 | 0.716 | 0.750 | 0.774 | 0.804 |
| 0.5 | 0.1 | 0.716 | 0.750 | 0.774 | 0.804 |
| 0.6 | 0.25 | 0.716 | 0.750 | 0.774 | 0.804 |
| 0.6 | 0.1 | 0.701 | 0.688 | 0.733 | 0.804 |

**`recall@K` is identical in all nine rows**, which confirms the structural point above. Recall
depends on the shortlist, the shortlist depends on BM25 and the quotas, and no threshold touches
either.

**`noneThreshold` was moved from 0.5 to 0.4 on this evidence.** It is never worse than any other
value on any metric, and against the previous default it gives `top1` 0.716 → 0.731, `noneRecall`
0.750 → 0.813 and `noneF1` 0.774 → 0.813. `minWinnerProbability` stays at 0.25: 0.1 performs
identically and 0.4 gives up `noneF1`, so 0.25 is the middle of a flat region rather than a guess.

The honest caveat is that the top-1 spread across the entire grid is 0.030, and run-to-run noise on
`noneP` was measured at roughly ±0.03. At one repeat per point, a 0.015 difference is a direction,
not a magnitude. The `noneRecall` and `noneF1` gains are larger and move together, which is why the
change was made, but this grid should be re-run at three or more repeats before the value is treated
as settled. That is recorded as a next step rather than presented as a settled result.

The quota axis was not swept through the API. It does not need to be: `recall@K` is the only metric
that depends on it and it is computable offline, which the table in the decisive finding uses. This
is cheaper and strictly more complete than sweeping it by brute force.

One defect found while running this, recorded because it invalidated an artifact rather than a
result: the sweep's JSON output omitted `minWinnerProbability`, so the nine rows could not be
attributed to configurations. The measurements were correct — only the serialisation was lossy — but
a sweep whose rows cannot be attributed is the same as no sweep, so the run was redone with the
field present and the table above is from the corrected run.

## Recommendation

The gate is not met, and the plan says phase 4 does not start until it is. The evidence says the
specific unmet criterion — `recall@K ≥ 0.90` — cannot be met by tuning, so the choice is a design
change or a changed expectation, not more measurement.

Three defensible paths:

1. **Change the retrieval stage.** Replace or augment BM25 with embeddings. This targets the actual
   cause and would plausibly reach 0.90, at the cost of an embedding model and a vector index, and
   it changes the "no server, BYO key" story because embeddings need a provider too.
2. **Lower the criterion to the measured ceiling** and proceed with hooks, documenting the retrieval
   limit honestly. `recall@K` 0.824 on the development set is a real product: the router is right
   about four times in five. The failure mode is a miss, not a wrong answer, because abstention
   already works at `noneF1` 0.75.
3. **Stop the plan here** and keep phase 1 and 2 as a working catalog and router with a measured,
   documented accuracy.

The decision belongs to the product, not to the harness. What the harness can state is that
option 2 ships a router that retrieves the right capability 82% of the time on the development
fixtures and 60% on a harder holdout set, that abstention works, and that the remaining gap is
lexical and not tunable.
