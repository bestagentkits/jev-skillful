# The outcome benchmark

The question this exists to answer: **does injecting a capability suggestion make an agent complete a
task better?**

It is the only question that matters, and as of this writing it has not been answered. This page
describes how the benchmark works, why it is built the way it is, and exactly what state it is in.

## Status

**The harness is complete. The benchmark has not been run.**

No `bench-outcome.json` exists, and none has been fabricated. The dashboard renders sections 5 and 6
as "not run", which is the truthful state.

Two of the four supported runtimes cannot complete a headless run on the development machine:

| Runtime | State |
|---|---|
| `claude-code` | OAuth session expired; needs a human with a browser to re-authenticate |
| `codex` | Quota reached, resets 2026-09-19 |
| `pi` | Working |
| `omp` | Working |

Check yours with:

```bash
npx @mrgoonie/skillful bench --probe
```

The probe runs a real prompt rather than checking for a binary on `PATH`, because a binary whose
credentials have expired fails at the first real task instead of at the probe. It inspects the output
rather than the exit code, because every runtime on this machine exits 0 while printing an
authentication or quota error.

## Why the aggregate lift is not the answer

The protocol follows [Skill Following](https://arxiv.org/abs/2609.00549), which shows that comparing
a group that received retrieval against a group that did not has serious selection bias, and can
report a positive lift while the true effect **on the tasks that received the treatment** is
negative. The tasks where injection fires are not a random sample; they are the tasks the router
judged to need a capability.

So two numbers are computed and they are always reported together:

| Metric | Computed over | Answers |
|---|---|---|
| **RAE** | only the tasks where injection happened | "when we did the thing, did it help" |
| Aggregate lift | every task | "did the average task get better" |

`assertReportable` refuses an impossible combination, and there is no code path that emits an
aggregate lift without an RAE beside it. A reporting rule that lives only in documentation is a rule
that gets broken by the next change.

## The four-cell table

|  | Control passed | Control failed |
|---|---|---|
| **Injected passed** | passed either way | **c** — rescued |
| **Injected failed** | **b** — harmed | failed either way |

The bottom-left cell is why the table is a required deliverable. If injection rescues ten tasks and
breaks eight, the mean looks like a small win and eight tasks got worse.

## How a task is run

1. A Docker image is built from the task's repository at its `base_commit`, keyed `repo@commit` and
   cached. Dependencies are installed at build time, so the measured run needs no network.
2. The test command runs **before** the agent, to confirm the target tests fail. A task whose tests
   already pass has no gap for the agent to close and is rejected.
3. The agent runs on the problem statement exactly as the dataset provides it. No hints are added,
   because adding hints would measure the hints.
4. The test command runs again. Success means every `failToPass` test passes and every `passToPass`
   test still passes. There is no model judging the diff and no human in the loop.
5. The other arm runs the same task in the same image at the same commit, from a clean checkout.

Both arms reset to the same commit, because otherwise the second arm inherits the first arm's changes
and the measured effect is an effect of ordering.

The container mounts only the repository. It never mounts a real home directory, so a hook cannot read
or write your agent configuration, and `TYPESAFE_API_KEY` is never passed into it.

## Success is a test verdict, not an opinion

A benchmark whose outcome depends on who is grading cannot support a claim about effect size. So the
verdict is mechanical: `failToPass` all passing, `passToPass` all still passing, exit code zero. A
test that does not run counts as failing, because a test that did not run has not passed.

## Injection is observed, not assumed

The treatment arm is not "the arm where injection was enabled". It is the arm where injection was
**recorded**. `SKILLFUL_DISABLE=0` means not disabled, which is not the same as routed-and-injected: a
degraded route injects a reminder, not a suggestion.

Reading this from the arm's own record matters because a degraded run counted as injected would
dilute the measured effect toward zero, and the dilution would look like the capability not helping. A
missing record counts as no injection, because that is the one place a benchmark could silently report
an effect that never happened.

## The pilot comes first

A real repository does not guarantee that any capability applies to any task. Without pre-screening, a
task the agent solves unaided contributes a pass to both arms and a task that is impossible
contributes a failure to both. Either way the measured effect shrinks for reasons unrelated to
injection, and "the capability did not help" becomes indistinguishable from "the capability was
irrelevant".

So the control arm runs first, on its own:

| Control result | Verdict |
|---|---|
| Passed | not capability-bound → moved to `neutral` or excluded |
| Failed | kept, because there is room for the treatment to show an effect |
| Failed with an environment error | excluded with the error; a build failure is not a task outcome |

Every exclusion is written to `excluded.json` with its reason. A suite whose exclusions are invisible
cannot be assessed: a reader cannot tell a carefully filtered 20 tasks from a 40-task suite that
quietly lost half its sample.

## The evidence threshold

Fixed before any benchmark runs, and not adjusted afterwards:

| Conclusion | Condition |
|---|---|
| `proven` | RAE > 0 **and** the 95% paired-bootstrap interval excludes zero |
| `not-proven` | the interval contains zero |
| `harmful` | RAE < 0 and the interval excludes zero |

A negative RAE with an interval containing zero is `not-proven`, not `harmful`, because the same lack
of evidence cuts both ways.

The bootstrap resamples **tasks**, not runs. Resampling runs would shrink the interval as repeats
increased without adding any new evidence, which is a way to manufacture significance by running the
same task more times. `taskLevelDifferences` reduces repeated runs to one outcome per task, majority
wins with a tie counting as failure.

## Power, and why the MDE is not optional

A null result without a minimum detectable effect reads as evidence that injection does not work. With
one, it reads as a statement about the sample. The MDE scales as `sqrt(discordance / n)`:

| Tasks | Discordance | Approximate MDE |
|---|---|---|
| 8 | 3 | 0.6 |
| 30 | 30% | 0.28 |
| 100 | 30% | 0.15 |

At 8 tasks only an enormous effect would be detectable, so reporting `not-proven` from 8 tasks would
be a statement about the sample dressed up as a statement about the tool. This is why the current
state is reported as **not run** rather than as `not-proven`: there is no interval at all.

When the arms never disagree the MDE is null rather than zero, and the report says the result is
uninformative rather than null. Zero would read as perfect sensitivity.

## Running it

```bash
# Which runtimes can actually run?
npx @mrgoonie/skillful bench --probe

# Pick the candidate set. The tasks must come from a real dataset.
npx @mrgoonie/skillful bench --suite bench/suites/core/suite.json --dry-run

# Control arm only, to classify each candidate.
npx @mrgoonie/skillful bench --suite bench/suites/core/suite.json --pilot

# Both arms over the screened suite.
npx @mrgoonie/skillful bench --suite bench/suites/core/suite.json --arms control,treatment --repeat 3
```

The suite on disk holds 8 real SWE-bench Verified instances and loads through the same code path any
larger suite would. Its difficulty labels are 15 minutes to 4 hours per task, so it is a plumbing
demonstration rather than a study.

## What would change the answer

In order of leverage:

1. Re-authenticate Claude Code, and wait out the Codex quota. That takes eligible coverage from 50% to
   100% with no code change.
2. Prefer repositories with fast unit tests. Eight astropy tasks are not a suite; thirty tasks against
   a repository with a fast test module could be.
3. Pre-build images at selection time so the pilot's cost is paid once and the suite's wall clock is
   agent time only.
4. Accept that a first run will likely be `not-proven` with an MDE in the 0.2–0.3 range. That is a
   finding about the sample, and the MDE is what makes it legible as one.
