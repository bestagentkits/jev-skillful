# Measurement

This document explains what the project measures, why it measures it that way, and how to read the
dashboard. It is the most important document here, because a routing tool that cannot demonstrate
that it helps is a routing tool that should not be used.

## Three layers, and only the third answers the question

| Layer | Question | Metric | Tool |
|---|---|---|---|
| L1 Retrieval | Is the right capability even in the shortlist? | `recall@K`, MRR | `skillful eval` |
| L2 Decision | Did the router choose well, and abstain well? | top-1 accuracy, `none` P/R/F1, stability | `skillful eval` |
| L3 Outcome | Did injecting make the agent do better? | RAE | `skillful bench` |

Layers 1 and 2 are **necessary conditions, not evidence**. A router can achieve perfect recall and
perfect top-1 accuracy against its own fixtures and still make agents worse in practice, because the
fixtures encode the author's beliefs about what should be retrieved. Only layer 3 compares outcomes.

## Why the aggregate lift is the wrong metric

The paper this protocol follows — [Skill Following](https://arxiv.org/abs/2609.00549) — shows that
comparing the mean outcome of a group that received retrieval against a group that did not has
serious selection bias, and can report a positive lift while the true effect **on the very tasks that
received the treatment** is negative.

The mechanism is straightforward once stated. The tasks where injection fires are not a random
sample: they are the tasks the router judged to need a capability. If those tasks differ
systematically from the rest, a between-group average measures the difference between the tasks, not
the effect of the treatment.

Two consequences shape everything here:

**RAE measures within-task.** Relative Agentic Efficiency is the difference in outcome on the *same
task*, run in two matched arms that differ only in whether injection happened.

**Analysis is conditioned on the invoked subset.** Only tasks where injection actually fired are
analysed. Tasks where the router abstained contribute nothing to the treatment effect, because
nothing was done to them.

## The four-cell table

Section 5 of the dashboard shows outcomes by arm, not a single number:

|  | Control passed | Control failed |
|---|---|---|
| **Injected passed** | both | injection helped |
| **Injected failed** | **injection hurt** | neither |

The bottom-left cell is the one an average hides, and it is the reason the table is a primary
deliverable rather than an appendix. A report that shows only the top row is not evidence.

## Reading the conclusion

The evidence threshold is fixed and was agreed before any benchmark ran:

| Conclusion | Condition | What it means |
|---|---|---|
| `proven` | `RAE > 0` **and** the 95% paired-bootstrap CI excludes 0 | Injection helped, and the sample is strong enough to say so |
| `not-proven` | CI contains 0 | No effect demonstrated at this sample size. This is not the same as "no effect" |
| `harmful` | `RAE < 0` | Injection made outcomes worse on the tasks it reached |

All three are reported. A `not-proven` or `harmful` result is a finding, not a failure to be worked
around, and the README and landing page are constrained by whichever one comes out.

## Power, and the honest use of MDE

With enough tasks, any real effect becomes detectable and any negligible one does not. The minimum
detectable effect is therefore reported alongside the result. If the MDE is larger than the effect
the tool could plausibly produce, the honest conclusion is "the sample was too small", not "the tool
does not work" — and the report says which.

Reporting RAE without the MDE would let a small null result read as a verdict.

## Section by section

**1. Overview** — prompts routed, and the rates of injection, abstention, degradation and cache hits.
Note that injection rate is not a quality measure: a router that injects rarely is not better than
one that injects often.

**2. Routing quality** — the L1 and L2 gate, with the targets as originally set. When a target is not
met it is shown as not met, rather than restated to match the result.

**3. Operations** — latency percentiles, token means, and the breakdown of degradations and
abstentions by cause. The breakdown matters more than the total: a recurring `auth` failure and
occasional network blips look identical in an average and need different responses.

**4. Adoption** — how often a suggestion was actually used. This is an **inference, not an
observation**. A use is counted as an acceptance when the same session was suggested that capability
within a ten-minute window. A session that used a capability for its own reasons therefore looks like
an acceptance, so the number is an upper bound. It exists because it separates the two failure causes,
but it should not be quoted as a measurement.

**5. Outcome benchmark** — RAE, aggregate lift, confidence interval, the four-cell table, and the
MDE. When the benchmark has not run, the section says so. It never shows a placeholder number.

**6. Where injection did harm** — the tasks that did worse with injection. This is the section that
decides whether the whole dashboard is trustworthy. A dashboard showing only good numbers is not
evidence, and the paper warns specifically about the aggregate that looks positive while the
conditioned effect is negative.

## What the appendix is for

The appendix lists what is missing from the numbers displayed above it: how many log lines were
unreadable and therefore excluded, how many capability uses were unobservable and therefore not
counted, and how many routes degraded and therefore decided nothing.

It exists because every number in the report is computed from a subset, and a reader who does not
know which subset cannot judge the number.

## Reproducing a result

```bash
skillful eval --recall-only                              # offline, no key, no cost
skillful eval --replay bench/replay/routing.json --repeat 5   # recorded responses, no key
skillful report --json                                   # the numbers behind the dashboard
```

`--replay` scores against recorded model responses, which is what lets the whole gate run with no key
and no network. It substitutes a fake fetch underneath the production router rather than
reimplementing the decision, so a replayed run cannot drift from a live one.
