## What this changes

<!-- One or two sentences. What behaviour is different after this, and why. -->

## How it was verified

<!--
For a change to routing, retrieval, thresholds, or fixtures, this section is required.
Paste the before and after of:

    npx skillful eval --replay bench/replay/routing.json --repeat 5 --json

The CI eval gate runs the same comparison, but a number in the PR body saves a review round trip
and shows the change was measured rather than assumed.
-->

## Checklist

- [ ] `pnpm test` passes.
- [ ] `pnpm typecheck` passes.
- [ ] If this touches `router/`, `retrieval/`, `config/`, or `bench/fixtures/`, eval numbers are
      included above.
- [ ] If this changes a threshold's default value, the evidence for the new value is included,
      and any caveat about the evidence is written next to the value in the source.
- [ ] No credentials, absolute home paths, or private project names are introduced. Corpus and
      fixture changes are checked with `skillful eval --snapshot-corpus` and inspected before commit.

## Known limitations

<!--
Optional but valued. If the change has a limit, a trade-off, or a case it does not handle,
say so here rather than leaving it for a reviewer to find.
-->
