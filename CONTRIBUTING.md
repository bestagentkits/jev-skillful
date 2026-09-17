# Contributing

The most valuable contribution to this project is **a bad routing case**. The fixture set is what
the router is measured against, and a fixture set grows best from real prompts that routed wrong.

## Reporting a bad routing decision

```bash
npx skillful export-case --prompt "the prompt that routed wrong"
```

The output is redacted before it is written: filesystem paths, environment values whose names look
sensitive, credential-shaped strings, email addresses, and any base URL you configured are all
removed. Paste it into the `bad-route` issue template. You do not need to review it for secrets,
though you are welcome to.

## Making a change

### Setup

```bash
pnpm install
pnpm build
pnpm test
```

### The rules that actually get enforced

**A change to routing, retrieval, thresholds or fixtures needs eval numbers.** Include the output
of:

```bash
npx skillful eval --replay bench/replay/routing.json --repeat 5 --json
```

before and after. The CI eval gate runs the same comparison, but numbers in the PR body save a
review round trip and show the change was measured rather than assumed.

**A change to a threshold default needs evidence.** Run the sweep, and if the evidence is weak, say
so next to the value in the source. There is a comment above `noneThreshold` that reads "the gain is
close to the noise already measured, so this is a defensible direction rather than a large effect".
That is the standard: the value and its caveat live together.

**Do not widen a fixture's gold answer after seeing the result.** If the router picks something
defensible that the fixture did not list, that is worth recording as an observation, not as a silent
fixture edit. Widening gold is how a fixture set stops measuring anything.

**Do not tune a metric by changing the metric.** If a target is not met, the honest options are to
change the design or to lower the target and say so.

**Nothing private goes into the repository.** This is a public repository and the corpus, fixtures
and reports are all committed. Project names, infrastructure URLs, absolute home paths and
usernames must not appear. Before committing anything derived from a catalog:

```bash
npx skillful eval --snapshot-corpus bench/corpus/distractors.json
git diff bench/corpus/distractors.json
```

Then read the diff. The redaction is a denylist plus a redaction pass and it can miss something; it
is a filter that ran, not a guarantee.

### Style

- Comments explain **why**, especially when the reason is a measurement, a failure, or a
  constraint that is not visible from the code. A comment that restates the code is noise.
- A function that can fail returns a result rather than throwing when its caller must not fail.
  The hook layer is the extreme case: nothing throws, because the host agent must not be disturbed.
- Prefer the smaller change. Two modules that share logic should share it, so that the safety rules
  cannot drift apart.

### Tests

`pnpm test` must pass. Beyond that, the tests that matter most here are the ones about **not
damaging things**: not removing another tool's hook, not overwriting an unparseable configuration
file, not caching a failure, not throwing out of a hook.

Network tests are opt-in:

```bash
SKILLFUL_TEST_NETWORK=1 pnpm test
```

Everything else runs offline. `skillful eval --replay` scores against recorded responses, so the
full gate runs without a key — which is exactly why it can run on a pull request from a fork.

## Code of conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
