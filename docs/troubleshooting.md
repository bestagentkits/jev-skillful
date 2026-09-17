# Troubleshooting

Start with:

```bash
npx skillful doctor
```

It reports whether the hook is enabled, whether a key is present, which runtimes have a hook, how
many capabilities were found, how many cache entries exist, and it runs one real route so you can
see the latency and the decision. Most problems resolve there.

## The hook injects nothing, ever

Work down this list.

1. **Is the key set?** `doctor` reports `[FAIL] api key` when `TYPESAFE_API_KEY` is missing or
   empty. Skillful reads it only from the environment, so exporting it in a different shell than
   the one your agent runs in has no effect.

2. **Is the hook installed?** `doctor` prints one line per runtime. `present, no hook` means run
   `npx skillful install`.

3. **Is it disabled?** `SKILLFUL_DISABLE=1` short-circuits the hook before any work. `doctor`
   reports it as a warning rather than a failure, because it is a legitimate setting.

4. **Did the session restart?** Claude Code and Codex read their hook configuration at session
   start. A hook installed mid-session does not take effect until you start a new one. Pi and OMP
   extensions can be reloaded with `/reload`.

5. **Does the prompt actually need a capability?** Most prompts do not. `doctor`'s trial route
   answers whether the pipeline itself works, which separates "the hook is broken" from "this
   prompt correctly matched nothing".

## The hook injects the reminder line every time

```text
[skillful] Could not resolve a capability suggestion...
```

That line means routing did not complete. The reason is one of `timeout`, `auth`, `upstream`,
`network`, `malformed` or `config`, and `doctor`'s live route check prints which. The hook itself
stays silent about the cause on purpose: it must not fill your agent's terminal with errors.

- `auth` — the key is wrong or expired.
- `network` — `doctor` can reach nothing. Check connectivity, and check that `SKILLFUL_BASE_URL`
  is not pointing somewhere unreachable. A configured base URL is honoured now; earlier versions
  resolved it and then silently discarded it, so if you set one and saw no effect, that was a bug
  rather than a misconfiguration.
- `timeout` — the budget ran out. Raise `SKILLFUL_BUDGET_MS`, or lower it deliberately and accept
  more degradation.
- `config` — the config file is malformed. `doctor` prints each warning.

A degraded result is never cached, so a transient outage does not freeze the behaviour for the
cache's lifetime. Recovery is immediate once the cause is fixed.

## It suggests the wrong capability

Run the same decision path with the internals visible:

```bash
npx skillful route --prompt "your prompt" --explain
```

This prints the shortlist, the BM25 score for each candidate, and the model's ranking. The two
answers are different and both matter:

- **The right capability is not in the shortlist.** This is a retrieval miss: BM25 did not match
  your prompt's words to the capability's description. Nothing downstream can recover from it.
  Adding a `when_to_use` field to the skill's frontmatter is the single highest-leverage fix,
  because that field is read for retrieval and is where routing intent belongs.
- **The right capability is in the shortlist and the model picked another.** This is a decision
  error. `show the full ranking` in the explain output tells you how close it was.

Then open an issue with `skillful export-case`, which produces a redacted block with everything
needed to reproduce it.

## Codex never fires the hook

Codex keeps a trust ledger at `~/.codex/config.toml` under `[hooks.state]`, mapping hook script
paths to a `trusted_hash`. Skillful installs into `~/.codex/hooks.json` and deliberately does not
write to that ledger, because authorising its own code inside another tool's security model is not
a decision an installer should make for you. Run Codex once and approve the hook when it asks.

## A settings file looks different

Every modification is preceded by a backup:

```bash
ls ~/.claude/settings.json.bak.skillful.*
```

Comparing the current file with the newest backup shows exactly what changed. Skillful only ever
touches entries carrying its own marker, so a diff that shows anything else is a bug worth
reporting.

If a configuration file was malformed, install reported it and wrote nothing. That is intentional:
refusing to act is recoverable, and clobbering a salvageable settings file is not.

## Uninstall left something behind

`skillful uninstall` removes its hook entries and its extension directory. What it leaves is the
backup files, on purpose, so you can restore an earlier state.

If a settings file that held nothing but the Skillful hook remains as an empty object, that is a
bug: it should have been removed. Earlier versions left an emptied `hooks.UserPromptSubmit: []`
behind, which was visible in a diff and survived into the next install.

## The cache

```bash
rm -rf ~/.cache/skillful
```

Deleting it costs one round trip per prompt until it refills. The cache never holds your prompt
text and never holds a key, so there is no reason to be careful about deleting it.

If a route seems stale after you installed or removed capabilities, it should not be: the catalog
fingerprint is part of the cache key, so any change to the catalog invalidates every entry
immediately. A stale decision that survives a catalog change is a bug.

## The catalog is empty or too small

```bash
npx skillful catalog --summary
```

A zero count usually means the scanner looked somewhere your capabilities are not. It reads
`~/.claude`, `~/.codex`, `~/.pi/agent` and `~/.omp/agent`, and honours `CODEX_HOME`, `PI_HOME`,
`OMP_HOME` and `AGENTKIT_OMP_HOME`.

Only `global` and `project` scopes in the current working directory are scanned. A capability in an
unrelated directory is not in the catalog, which is why running from the project you are working in
matters.

## `npx` is slow

Each hook invocation is a Node process. On a cold start that is most of the budget. The installer
points the hook at an absolute `node` path and an absolute CLI path rather than going through
`npx`, so the hook does not pay `npx`'s resolution cost. If you installed an older version that
used `npx`, reinstalling rewrites the command.

Measured on this machine: a cold route through the hook took 1446ms against the 2000ms budget, and
a cache hit took 221ms.

## Reporting a problem

- **Bad routing** — `skillful export-case --prompt "..."`, then the `bad-route` issue template.
- **Install or hook** — `skillful doctor`, then the `install-problem` issue template.
- **A vulnerability** — [privately](https://github.com/bestagentkits/jev-skillful/security/advisories/new),
  never in a public issue.
