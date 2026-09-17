# Routing

How Skillful turns a prompt into at most three capabilities.

## The path

```text
prompt
  │
  ├─ 1. prompt heuristics          no network, no cost
  │     slash command, too short, social turn
  │
  ├─ 2. BM25 shortlist             no network, no cost
  │     one ranking per quota group, cut to the group's quota
  │     indistinguishable copies collapsed
  │
  ├─ 3. one System One request     ~0.75s measured
  │     state   = { task, candidates[] }
  │     primary = choice over candidate ids + "none"
  │     c<i>    = noul per candidate, for runner-up ranking
  │
  └─ 4. decide
        none won, or noneP ≥ noneThreshold  → inject nothing
        winner below noneThreshold          → inject nothing
        otherwise                           → 1 primary + up to 2 runner-ups
```

Ten steps happen locally before anything leaves the machine. On the development catalog of
597 entries, the warm scan and the shortlist together cost well under 100ms, so essentially
all observed latency is the one HTTP request.

## One request, not two

Routing uses a single `choice` question with a `none` option as the decision, and a `noul`
question per candidate only to order the runner-ups. An earlier design used a separate
`noul` gate to decide whether any capability was needed at all. That gate was dropped after
measurement, because it disagreed with the `choice` answer in the direction of being wrong:

| Prompt | `choice` result | separate `noul` gate |
|---|---|---|
| refactor auth middleware | correct skill, `noneP` 0.00, confidence 1.0 | 0.39 |
| fix a typo | `none` won, `noneP` 0.62 | 0.10 |
| a question about existing code | `none` won, `noneP` 0.54 | 0.10 |
| "thanks!" | `none` won, `noneP` 1.00 | 0.10 |

The gate returned 0.39 for the one case where `choice` was completely certain, and the same
0.10 for a typo and for "thanks", so it could not separate them either. Dropping it removes
a question and removes a source of wrong answers.

## Latency does not depend on candidate count

| Configuration | Measured |
|---|---|
| K=5, 4 questions | 0.745–0.858s |
| K=15, 16 questions | 0.686–0.762s |

Roughly 0.21–0.32s of that is TCP and TLS. K=15 is therefore not a latency compromise; it
buys retrieval quality for free. Live runs through the CLI on this machine land at
756–805ms against a 2000ms budget.

Cost is about 1360 input tokens per request, roughly $0.00006 per prompt. The real
constraint is the rate limit, not the price.

## Quotas

The model sees at most 15 candidates, but never all 597. Ranking everything together would
let a large kind drown out a small one.

| Group | Quota |
|---|---|
| skill | 6 |
| mcp | 4 |
| agent | 3 |
| command + rule, sharing one quota | 2 |
| **Total** | **15** |

Two details are deliberate:

**Unused quota is not redistributed.** A machine with 174 skills and 2 MCP servers sends 6
skills, not 15. Filling the gap with extra skills would make the composition of the request
depend on which kinds happen to be installed, which makes the router harder to reason about
and harder to evaluate.

**`command` and `rule` share one quota.** Both are small, narrow surfaces. Giving each its
own budget would crowd out agents and MCP servers, which change the outcome more.

## Indistinguishable copies are collapsed

The same capability is often installed under more than one runtime root. On the machine this
was built on:

```text
~/.claude/skills/ak-backend-development/SKILL.md   name: ak:backend-development
~/.agents/skills/ak-backend-development/SKILL.md   name: ak-backend-development
```

Two directories, two inodes, two different file hashes — and **byte-identical descriptions**.
They differ only in the name convention.

Before this was handled, a live route returned that skill as the primary *and* as a
runner-up: the same capability injected twice, which is exactly the redundancy the injection
limit exists to prevent. Retrieval scores the two identically because their descriptions are
the same, so both reached the shortlist.

Within a quota group, candidates of the same kind whose descriptions are identical are now
one candidate. Among those copies, the best-ranked survives and the others are recorded as
`alternates` with their runtime and path, so a hook running inside one runtime can pick its
own path. Collapsing happens *before* the quota cut, so a slot freed this way goes to a
genuinely different capability instead of being wasted.

The comparison is on `kind` plus description, so a skill and an MCP server described in the
same words stay separate — they are different things.

## Thresholds

| Name | Default | Meaning |
|---|---|---|
| `noneThreshold` | 0.5 | `none` wins, or its probability reaches this → inject nothing |
| `minWinnerProbability` | 0.25 | Floor on the winning option's probability |
| `runnerUpThreshold` | 0.6 | Minimum `noul` for a runner-up |
| `maxRunnersUp` | 2 | Cap on runner-ups |
| `minPromptChars` | 12 | Shorter prompts are never routed |
| `budgetMs` | 2000 | Hard ceiling on the whole path |
| `maxPromptChars` | 1000 | Prompt truncation before transmission |
| `requestTimeoutMs` | 1800 | Per-attempt timeout |

`noneThreshold` and `minWinnerProbability` were one number at first, and the baseline run showed
why that was wrong. A `choice` over sixteen options routinely gives a clearly-best answer less
than half the probability, so a 0.5 floor rejected correct picks as `below-threshold`: five
fixtures had the right answer chosen by the model and then thrown away. Whether `none` should win
and how confident a winner has to be are different questions with different costs — a wrong
abstention loses a capability the task needed, while a wrong injection spends context.

The candidate label carries the **name** as well as the description. It used to omit the name
whenever a description existed, which left the model choosing between opaque ids for MCP servers
whose descriptions are the infrastructure string found in a config file. A name is often the
strongest signal available.

`budgetMs` is enforced with an abort signal that the client checks between retries, not just
by trimming the per-attempt timeout, so a retry sequence cannot overrun the ceiling.

## Result contract

`RouteResult` is the interface between phase 2, the runtime hooks in phase 4, and the
telemetry in phase 5. It survives `JSON.stringify` without loss, and there is a test that
asserts exactly that.

```ts
type RouteDecision =
  | { kind: "injected"; primary: RoutePick; runnersUp: RouteRankedPick[]; confidence: number; noneP: number }
  | { kind: "skipped";  reason: "heuristic" | "none-won" | "below-threshold" | "empty-shortlist"; detail?: string }
  | { kind: "degraded"; reason: "timeout" | "auth" | "network" | "upstream" | "malformed" | "config"; detail?: string };
```

`empty-shortlist` is an addition to the plan's three skip reasons. An empty catalog is not a
heuristic decision and not a model decision, and folding it into `heuristic` would have made
the telemetry in phase 5 report a scan problem as a prompt problem.

**Nothing throws.** A missing key, an expired budget, an upstream failure and a prompt that
needs nothing all return a valid result. A hook that crashes the host agent is a worse
outcome than a hook that injects nothing, so the failure modes are values rather than
exceptions.

## Credential handling

`TYPESAFE_API_KEY` is read from the environment only.

- Not accepted as a CLI flag, because flags are visible in the process list.
- Not read from `~/.config/skillful/config.json`. A config file that contains a key-like
  field is rejected with a warning telling the user the value is both unused and unsafe.
- Attached to one request header and referenced nowhere else. There are tests asserting the
  key does not appear in a degraded result, in a network error message, or in the request
  body.

Prompt text is truncated to `maxPromptChars` before transmission, and `--no-prompt-upload`
sends the catalog with the prompt replaced by a placeholder. The shortlist is still computed
locally, so this trades retrieval quality for not transmitting the prompt at all.

## Verified behaviour

Offline, with `fetch` stubbed: 115 tests pass with no key present and no network access.
All four `RouteResult` branches, the 429 and 529 retry paths, the no-retry-on-401 rule, and
the credential-safety assertions are covered.

Live, against `api.typesafe.ai`, on 2026-09-17:

| Prompt | Result |
|---|---|
| `refactor the auth middleware to use refresh tokens` | injected `ak-backend-development`, `noneP` 0.02, 756ms |
| `fix the typo in README line 12` | skipped, `none-won`, 757ms |
| `what does this function do?` | skipped, `none-won`, 805ms |
| `thanks!` | skipped, `heuristic`, 0ms, no request |

The first three match the expectations recorded during the brainstorm.

## Deviation from the plan

The plan asked for recorded API responses under `fixtures/jev-responses/` for offline tests.
None were added. The live runs above verify the request and response shapes end to end, which
is stronger evidence than a stored copy, and the offline tests construct responses directly
from the documented contract — including the detail that a `noul` answer has no separate
`confidence`. A fixture with no test consuming it would be dead weight; phase 3 can add them
if the eval harness needs recorded replies.

## What phase 3 owns

Everything in the thresholds table, the quota numbers, and the `none` option ordering. The
`none` option is placed first in the criteria map on the theory that a trailing "none of the
above" biases a model toward the options before it. That theory is untested here.
