# Skillful

A capability router for coding agents. It watches your prompts, decides whether a skill, MCP
server, subagent or slash command you already have installed is relevant, and injects at most one
suggestion into the agent's context.

```bash
npx skillful install
```

You bring your own `TYPESAFE_API_KEY`. There is no server, no account, and nothing is collected.

## The problem

The usual way to make an agent aware of a skill is to list every skill in the context window. This
does not scale. [Skill Retrieval Augmentation for Agentic AI](https://arxiv.org/abs/2604.24594)
found that as the skill corpus grows, context budget is consumed quickly and **the agent becomes
less accurate at picking the right skill**. The same work also found that current agents tend to
load skills at a similar rate regardless of whether the task actually needs an external capability
— so the bottleneck is both *which* capability and *whether* to load one at all.

That is the situation this project targets. A development machine here has around 230 skills across
two agent runtimes, plus MCP servers, subagents and commands.

## How it works

```text
Your prompt
  │
  ├─ Hook (Claude Code / Codex / Pi / OMP)
  │    cache lookup by prompt hash + catalog fingerprint
  │    hit  → inject (<250ms)
  │    miss → route within a 2000ms budget
  │    error or over budget → inject one reminder line, never fail the prompt
  │
  ├─ Catalog scan (local, no tokens)
  │    every capability on the machine, normalised
  │    BM25 + per-kind quota → a shortlist of about 15
  │
  ├─ One TypeSafe request
  │    a `choice` question over the shortlist plus `none`
  │    per-candidate `noul` questions to rank the runners-up
  │
  └─ Inject at most 1 primary + 2 runner-ups, or nothing
```

Two design choices are worth stating because they are deliberate:

**The shortlist is what the model sees, not what gets injected.** Injecting all fifteen candidates
on every prompt would reproduce the exact "enumerate every available skill" pattern that made
retrieval necessary. The cap is one suggestion plus two alternatives.

**Abstaining is a first-class outcome.** A prompt that does not need a capability gets nothing
injected. Trivial prompts, questions and chit-chat are handled by the `none` option in the same
question that picks the capability, rather than by a separate classifier with its own failure mode.

## What is actually measured

This section reports what has been measured, and nothing that has not.

**Routing quality** is measured by `skillful eval` against 67 development fixtures and 22 holdout
fixtures, over a corpus of 533 sanitised catalog entries:

| Metric | Result | Target |
|---|---|---|
| `recall@K` (holdout) | **0.600** | 0.90 |
| `recall@K` (development) | **0.824** | 0.90 |
| MRR (development) | 0.574 | — |
| `top1Accuracy` (development) | 0.731 | 0.80 |
| `noneF1` (development) | 0.813 | 0.80 |
| `agreementRate` | 0.985 | 0.90 |
| p95 route latency | 406ms | 1500ms |

**The routing targets are not met, and the gap is not a tuning problem.** `recall@K` depends only
on the shortlist, which is built entirely by BM25 and the quotas, so it can be swept with no API
calls at all. Growing the shortlist from 13 entries to 21 raised recall from 0.600 to 0.650. Recall
saturates well below the target because BM25 matches tokens: it retrieves a capability only when a
prompt happens to share vocabulary with a capability description, and prompts are phrased as tasks
while descriptions are phrased as capability statements. Closing the gap needs a different
retrieval stage, not a different parameter.

Two further limits, recorded rather than tuned away. Prompts in Vietnamese reached `recall@K`
0.429, matching only through loanwords, because capability descriptions are written in English and
there is no shared vocabulary to match on. And MCP retrieval cannot be measured fairly against a
sanitised corpus, because an MCP entry's catalog description is the transport string read from a
config file, which after redaction carries no retrievable text.

**The outcome benchmark does not exist yet.** Whether injecting a suggestion actually makes an
agent complete a task better is a separate and harder question, and it is the one that matters. It
requires comparing outcomes on the same task with and without injection, over a real repository, in
a frozen container, with a paired analysis on the subset of tasks where injection actually
happened. That work is phase 7 of the plan. Until it reports, this project claims a routing
improvement and **does not claim a task-outcome improvement**. Any use of the words "makes your
agent better" here would be unsupported.

A caution worth carrying: an earlier version of these numbers showed `recall@K` 0.804 on the
development set. That figure was inflated. MCP descriptions contained private service URLs and
BM25 was matching a server's name out of the URL. Sanitising the corpus removed the text and the
number fell to its honest value. A retrieval result that depends on a leaked URL is not a result.

## What it has been verified to do

- Installs a hook for all four runtimes, idempotently, with a timestamped backup before modifying
  any file, and removes exactly what it added.
- Leaves another tool's hooks untouched. If a configuration file cannot be parsed, install reports
  it and writes nothing.
- Fails open. A missing key, an unreachable network, an upstream error, or an expired budget each
  produce one reminder line and exit 0. Nothing is ever written to stderr, because a hook that
  disturbs an agent session is worse than one that suggests nothing.
- A cold route through the hook took 1446ms against a 2000ms budget; the same prompt again hit the
  cache in 221ms with byte-identical output; `thanks!` injected nothing.
- Codex's quota on the development machine was exhausted until 2026-09-19, so a live Codex session
  receiving an injection is not yet verified. The install itself is.

## Commands

```bash
npx skillful install              # install the hook for every runtime present
npx skillful doctor               # is it working? includes a live trial route
npx skillful uninstall            # remove it, leaving other hooks alone

npx skillful catalog --summary    # what capabilities were found
npx skillful route --prompt "..." --explain   # the decision, with the shortlist and scores
npx skillful eval --recall-only   # sweep quotas offline, no key and no cost
npx skillful eval --replay FILE   # score against recorded responses, no key
npx skillful export-case --prompt "..."   # a redacted case to paste in an issue
```

## Privacy

- The prompt is sent to `api.typesafe.ai` as part of the routing request. This is the only kind of
  network call Skillful makes.
- `SKILLFUL_UPLOAD_PROMPT=false` routes without transmitting the prompt. The shortlist is still
  chosen locally, so this trades retrieval quality for not sending the text.
- Route decisions are cached in `~/.cache/skillful/routes.json` so a repeated prompt does not pay
  twice. The cache never stores your prompt and never stores a key.
- Nothing is collected. There is no telemetry that leaves the machine.

## Security

`skillful install` writes an extension for Pi and OMP. Extensions run with your full user
permissions. Skillful's is about forty lines: it spawns the CLI, reads one line of JSON back, and
injects it. Read it at `~/.pi/agent/extensions/skillful/index.ts` before trusting it. See
[SECURITY.md](SECURITY.md) for how to report a vulnerability.

## Documentation

- [docs/install.md](docs/install.md) — install, uninstall, doctor, troubleshooting
- [docs/architecture.md](docs/architecture.md) — the catalog, the router, the four hook mechanisms
- [docs/routing.md](docs/routing.md) — the questions, thresholds and quota design
- [docs/evaluation.md](docs/evaluation.md) — how the router is measured, and the results
- [docs/measurement.md](docs/measurement.md) — the three layers, RAE, and how to read the dashboard
- [docs/telemetry.md](docs/telemetry.md) — what is logged, what is never logged, and how to turn it off
- [docs/troubleshooting.md](docs/troubleshooting.md) — when it does not work

## Contributing

Contributions are welcome, and the most valuable one is a bad routing case. Open an issue with
`skillful export-case` output; that is how the fixture set grows into something that measures
reality rather than the author's guesses.

A change to routing, retrieval, thresholds or fixtures is expected to include eval numbers. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
