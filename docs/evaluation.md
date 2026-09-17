# Evaluation

How Skillful's routing quality is measured, and what the numbers mean.

## Why this exists before the hooks do

The router's whole value is choosing the right capability, or correctly choosing none. That
is measurable without any runtime integration, so it is measured first. Building four runtime
hooks convinced that routing works would have produced a great deal of integration code
resting on an assumption.

A failed gate is an acceptable outcome. It is recorded with the configurations that were
tried, so the same ground is not covered twice.

## Two layers, measured separately

Measured together, a low score says nothing about what went wrong. The split follows
SRA-Bench, which separates retrieval from incorporation from end-task success. This harness
owns the first two; the end-task benchmark is a later phase.

**Layer 1 — retrieval.** Did the shortlist contain the right capability?

| Metric | Meaning |
|---|---|
| `recall@K` | Share of fixtures where at least one gold capability reached the shortlist |
| `MRR` | Mean reciprocal rank of the first gold capability |
| `goldInShortlistRate` | Share of gold *items* that reached the shortlist |

The last two are worth separating. A fixture with three acceptable answers satisfies
`recall@K` if any one of them is offered, while `goldInShortlistRate` reports how many of the
three were. The gap is the cost of a narrow shortlist.

`recall@K` is a ceiling on everything downstream. A capability that never reaches the
shortlist cannot be chosen, and no amount of prompt tuning will fix it.

**Layer 2 — decision.** Given what it saw, did the router choose correctly?

| Metric | Meaning |
|---|---|
| `top1Accuracy` | Right capability picked, or abstained when it should have |
| `abstentionCorrectness` | Right *kind* of decision, ignoring which capability was picked |
| `nonePrecision` / `noneRecall` / `noneF1` | Abstention treated as the positive class |
| `degradedRate` | Runs that failed rather than deciding |

Abstention is its own axis because it does not follow from retrieval quality. SRA-Bench
observed agents loading skills at a similar rate whether or not the task needed one, which
means a router can post respectable accuracy on a mostly-positive fixture set while being
harmful on ordinary prompts, which need nothing.

`abstentionCorrectness` and `top1Accuracy` differ by exactly the cost of retrieval misses. A
large gap means the router is judging correctly and retrieving poorly.

Abstain fixtures are excluded from layer 1. There is no gold to retrieve, and counting "no
gold found" as a miss would score a correct abstention as a retrieval failure.

## Stability is measured, not assumed

Jev is not deterministic. Repeated identical input moved `noneP` by roughly ±0.03, and an
earlier note recorded option distributions shifting from 53/47 to 61/39. A single pass
therefore cannot separate signal from noise, and a threshold sitting in that noisy band will
flip between runs.

`agreementRate` is the share of fixtures whose decision was identical across every repeat. It
is reported next to accuracy rather than in an appendix, because an accuracy number produced
by one run per fixture is not reproducible and should not be trusted.

## Latency is reported as percentiles

`budgetMs` is a hard ceiling, so what matters is how often the tail crosses it. A mean hides
the p95 that blows the budget. Percentiles use the nearest-rank method, so a reported figure
is a duration that an actual request took rather than an interpolated value no request
achieved.

## The corpus, and why it is mostly distractors

The eval corpus is a snapshot of a real machine's catalog, pinned to
`bench/corpus/distractors.json` so a report can be reproduced after the machine changes.

Most of it is distractor rather than gold. SRA-Bench warns that a fixture set containing only
gold items makes retrieval artificially easy, and the faithful and cheap distractor set is
the real catalog: 227 skill names, 5 MCP servers, 25 agents, with the real near-misses that
make retrieval hard. The gold capabilities for the 75 fixtures are a small subset of it.

The snapshot is filtered. See "Publishing a corpus" below.

## Fixtures

75 fixtures across seven groups:

| Group | Purpose |
|---|---|
| `coding` | Technical tasks that need a skill |
| `marketing` | Domain tasks, which exercise the kind quotas |
| `mcp` | Tasks whose right answer is an MCP server |
| `agent` | Tasks better delegated to a subagent |
| `trivial` | Must abstain: chitchat, very short requests, and questions answerable from context |
| `ambiguous` | Several defensible answers, declared as an array |
| `vietnamese` | Prompts in Vietnamese, so the tokenizer is measured rather than assumed |

Gold is written as a capability **name**, not an id. The same skill is normally installed
under several runtime roots — `~/.claude/skills/`, `~/.agents/skills/` — and which copy was
injected does not change whether the task worked. A name resolves to every id carrying it,
and any of them counts as correct.

Name matching normalises the `:` and `-` conventions, because the same skill is named
`ak:debug` on one runtime and `ak-debug` on another depending on which runtime wrote the
frontmatter. The shortlist already treats those copies as one candidate, so gold matching has
to agree; otherwise a correct pick is scored as a miss purely because the other runtime's copy
was chosen.

### Development and holdout

`routing.jsonl` is the development set, used for tuning. `routing.holdout.jsonl` is touched
only to confirm a configuration chosen on the development set. Confirming on the set used to
tune would make the confirmation circular.

A gold capability that no longer exists in the corpus is a hard error, not a skipped fixture.
A fixture whose gold has disappeared no longer measures what it claims to.

## The gate

Checked on the holdout set:

| Metric | Minimum |
|---|---|
| `recall@K` | 0.90 |
| `top1Accuracy` | 0.80 |
| `noneRecall` | 0.90 |
| `noneF1` | 0.80 |
| `agreementRate` | 0.90 |
| p95 latency | at most 1500ms |

## Measured outcome

The gate has been run on a development set of 67 fixtures and a holdout set of 22, against a
corpus of 533 sanitised catalog entries. Live against the API, at three repeats per fixture.

**The gate is not met.** `recall@K` is the criterion that blocks it:

| Set | `recall@K` | MRR | `agreementRate` | p95 |
|---|---|---|---|---|
| Development (57 non-abstain) | 0.824 | 0.574 | 0.985 | 406ms |
| Holdout (20 non-abstain) | 0.600 | 0.348 | — | — |

The criterion asks for 0.90. Sweeping the shortlist size shows why that is out of reach by tuning:

| Skill quota | Shortlist size | `recall@K` (holdout) |
|---|---|---|
| 4 | 11 | 0.550 |
| 6 | 13 | 0.600 |
| 8 | 15 | 0.600 |
| 14 | 21 | 0.650 |

Growing the shortlist by 90% buys five points. Recall saturates well below the criterion, because
BM25 matches tokens: it retrieves a capability only when a prompt happens to share vocabulary with
a capability description. Prompts are phrased as tasks and descriptions as capability statements,
and the model that does the choosing can bridge that gap while the prefilter cannot.

Closing it needs a different retrieval stage — embeddings or a learned retriever — not a different
parameter.

### What did improve, and by how much

| Change | dev `recall@K` | holdout `recall@K` | holdout MRR |
|---|---|---|---|
| Baseline | 0.765 | 0.500 | 0.264 |
| Include `when_to_use` in retrieval and in the request | **0.824** | **0.600** | **0.348** |

`when_to_use` is a frontmatter field present on 203 of 230 skills, written for exactly this
decision — `Invoke when the user wants honest advice, a second opinion, requirement reframing`.
The reader had been discarding it. It was validated offline on both sets before being implemented.

Two other corrections came out of the same measurement round. Whether `none` should win and how
confident a winner must be were gated by one number, and a `choice` over sixteen options routinely
gives a clearly-best answer under half the probability, so correct picks were being discarded; they
are now separate thresholds. And the candidate label omitted the capability's name whenever a
description existed, which left the model choosing between opaque ids for MCP servers whose
descriptions are config-file strings.

### Limitations

**Non-English prompts retrieve poorly.** Prompts in Vietnamese reached `recall@K` 0.429, matching a
capability only through loanwords such as `api` or `postgres`, because capability descriptions are
written in English and BM25 has no shared vocabulary to match on. This is lexical, not tunable.

**MCP retrieval is not measured fairly by a sanitised corpus.** An MCP entry's catalog description
is the transport and target read from a config file, which after redaction carries no retrievable
text. The fix is for the catalog to describe an MCP server by the tools it exposes.

One earlier measurement is worth recording as a caution. Recall first measured 0.804 on the
development set, which turned out to be inflated: MCP descriptions contained private service URLs,
and BM25 was matching the server's name out of the URL. Sanitising the corpus for publication
removed that text and the number dropped to its honest value. A retrieval result that depends on a
leaked URL containing a server name is not a retrieval result.

## Running it without a key

`--record` captures live responses; `--replay` answers from them. Replay substitutes a fake
`fetch` underneath the production router rather than reimplementing the decision, so a
replayed run exercises the same shortlist, thresholds and abstention logic as a live one and
cannot drift from it.

Recorded responses are keyed by the exact `state.task` string the request carried, so a
recording still matches when a prompt was truncated or withheld by `--no-prompt-upload`.

One limitation to state plainly: replaying `--repeat 1` recordings for a `--repeat 5` run
cycles the same response, which reports perfect stability that was not measured. Agreement
numbers are only meaningful from live runs, or from recordings made with matching repeats.

## Publishing a corpus

The snapshot is committed to a public repository, and a capability name is not neutral
metadata. Names describing a production cutover, a staging host, or a customer migration step
disclose infrastructure topology and operational history.

`saveCorpus` therefore withholds entries matching known private-project markers by default,
and records how many were withheld so a reader can distinguish a filtered corpus from a
complete one. A filtered corpus is a marginally easier retrieval problem, because some
near-misses are gone, and reports say so rather than presenting it as the full catalog.

Two properties of the filter are deliberate:

- Short markers need word boundaries. A plain `orca` substring matches `orchestration`, a
  public skill, and there is a regression test for exactly that.
- The withheld names are not written into the snapshot; only the count is.

The filter is a denylist, and a denylist can miss something. It is reported as a filter that
ran, not as a guarantee, so an artifact derived from a sanitised corpus should still be read
once before publication.
