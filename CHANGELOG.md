# Changelog

## 0.1.0

First public release. What is here:

**Router.** One TypeSafe request per prompt decides which capability a task needs, from a shortlist
built locally by BM25 and per-kind quotas. The prompt can be withheld from the request. Ships with
`skillful route --explain` to show the shortlist, the BM25 scores and the model's ranking.

**Catalog.** Scans four runtimes and both scopes for skills, MCP servers, subagents, slash commands
and rules, and normalises them into one shape with a stable identity and a fingerprint.

**Hook.** Installs for Claude Code, Codex, Pi and OMP. Two mechanisms cover all four, because two
pairs share a contract. Fails open: every error is swallowed, the exit code is always 0, and nothing
is written to stderr. Route decisions are cached so a repeated prompt does not pay twice.

**Evaluation.** `skillful eval` measures retrieval and decision quality against fixtures and a
distractor corpus, with stability, agreement rate and percentiles. `--replay` scores against
recorded responses with no key and no network, which is what lets the CI gate run on pull requests
from forks. `--recall-only` sweeps quotas offline at no cost.

**Measured, and reported honestly.** `recall@K` is 0.824 on the development fixtures and 0.600 on
the holdout, against a target of 0.90. The gap is structural rather than tunable: recall depends
only on the shortlist, and BM25 matches tokens, so it retrieves a capability only when a prompt
shares vocabulary with a capability description. Growing the shortlist by 90% raised recall by five
points. Two further limits are recorded rather than tuned away: non-English prompts retrieve poorly
for the same lexical reason, and MCP retrieval cannot be measured fairly against a sanitised corpus.

**What is not here.** The outcome benchmark. Whether injecting a suggestion makes an agent complete
a task better is the question that matters, and it is not answered yet. Until it is, this project
claims a routing improvement and does not claim a task-outcome improvement.

### Notes on the numbers

An earlier development-set figure of `recall@K` 0.804 was inflated by a leak: MCP descriptions
contained private service URLs and BM25 matched a server's name out of the URL. Sanitising the
corpus for publication removed the text, and the honest number fell to 0.765 before the
`when_to_use` improvement raised it to 0.824.
