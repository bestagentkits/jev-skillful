# Install

Skillful installs a hook into each agent runtime it finds on your machine. After that, every
prompt you type gets one TypeSafe request that decides whether a capability you already have
installed is relevant, and injects at most one primary suggestion plus two runner-ups.

## Requirements

- Node 20 or newer.
- A `TYPESAFE_API_KEY` from [typesafe.ai](https://typesafe.ai). Skillful reads it **only** from
  the environment. It never writes it to a config file, a cache, or a log, and a config file that
  tries to set one is rejected with a warning.

## Install the hook

```bash
npx @mrgoonie/skillful install
```

The command detects which runtimes are present and installs for each. Only the runtimes whose
configuration directory exists are touched:

| Runtime | What is written | Mechanism |
|---|---|---|
| Claude Code | `~/.claude/settings.json` → `hooks.UserPromptSubmit` | command hook |
| Codex | `~/.codex/hooks.json` → `hooks.UserPromptSubmit` | command hook |
| Pi | `~/.pi/agent/extensions/skillful/index.ts` | extension |
| OMP | `~/.omp/agent/extensions/skillful/index.ts` | extension |

Useful flags:

```bash
skillful install --dry-run              # show what would change, write nothing
skillful install --runtime pi           # only one runtime, repeatable
skillful install --json                 # machine-readable report
```

Then restart your agent session.

## What was written to your files

Installing modifies configuration files that other tools also use, so the rules are strict and
they are enforced by tests:

- **A timestamped backup is taken before any file is modified.** `settings.json` becomes
  `settings.json.bak.skillful.<timestamp>`. Backups are kept, not cleaned up, so you can always
  recover the state before an install.
- **A file that cannot be parsed is never overwritten.** If your settings file is malformed,
  install reports it and moves on. Refusing to act is recoverable; clobbering a salvageable
  settings file is not.
- **Only Skillful's own entries are touched.** Every other hook, in every other event, keeps its
  exact position. Uninstall removes only what install added and restores the file to its original
  content; if the file held nothing but the Skillful hook, it is removed entirely.
- **Writes are atomic.** A temp file is written and renamed into place, so an interrupted install
  cannot leave a truncated configuration behind.
- **Installing twice changes nothing.** The second run reports `already installed` and does not
  rewrite the file.

Verify what happened at any time:

```bash
skillful doctor
```

## The Codex caveat

Codex keeps a trust ledger in `~/.codex/config.toml` under `[hooks.state]`, mapping hook script
paths to a `trusted_hash`. Its hooks live in `~/.codex/hooks.json`, and the two are related: the
ledger is how Codex records that it has been told to trust a particular hook.

Skillful installs into `~/.codex/hooks.json` and **does not write to that ledger**. Fabricating a
`trusted_hash` for itself would mean authorising its own code to execute inside another tool's
security model without you being asked, which is not a decision an installer should make on your
behalf. If the hook does not fire, run Codex once and approve it when prompted.

## Configuration

Optional. Skillful works with defaults and no config file.

`~/.config/skillful/config.json`:

```json
{
  "model": "jev-latest",
  "thresholds": {
    "noneThreshold": 0.4,
    "minWinnerProbability": 0.25
  }
}
```

Environment variables override the file, and CLI flags override both. The full set is listed in
`skillful --help`. Two in particular:

- `TYPESAFE_API_KEY` — required. Environment only.
- `SKILLFUL_DISABLE=1` — turn the hook off completely, with no other effect.

## Fail-open behaviour

The hook is designed so that it can never make your agent worse through a failure:

- Every error is swallowed. The hook exits 0 in all cases and writes nothing to stderr.
- If the API key is missing, the network is down, the service returns an error, or the two-second
  budget expires, one short reminder line is injected (or nothing at all) and your prompt
  proceeds normally.
- A prompt that does not need a capability injects nothing at all.

`skillful doctor` is where the errors the hook hides are surfaced. The hook stays quiet so your
agent session does not fill with noise; doctor tells you the truth when you ask for it.

## Privacy

- The prompt text is sent to `api.typesafe.ai` as part of the routing request. This is what makes
  the routing work, and it is the only network call Skillful makes.
- `SKILLFUL_UPLOAD_PROMPT=false` routes without transmitting the prompt. The shortlist is still
  chosen locally from your prompt, so this trades retrieval quality for not sending the text.
- Route results are cached in `~/.cache/skillful/routes.json` so a repeated prompt does not pay
  for a repeated round trip. The cache stores the routing decision; it never stores your prompt
  and never stores an API key. It is written `0600` and can be deleted at any time.
- Nothing is collected, and nothing is sent anywhere except that one API call.

## Security

Extensions run with your full user permissions and can execute arbitrary code. The Pi and OMP
extension Skillful writes is about forty lines: it spawns the Skillful CLI, reads one line of
JSON back, and injects it. It does nothing else. Read it before you trust it — at
`~/.pi/agent/extensions/skillful/index.ts`.

## Uninstall

```bash
skillful uninstall
```

This removes the hook entries and the extension directories. Backup files are left in place so you
can restore an earlier state if you want to.

## Troubleshooting

Start here:

```bash
skillful doctor
```

It reports whether the hook is enabled, whether a key is present, which runtimes have a hook,
how many capabilities were found, how many cache entries exist, and it runs one real route so you
can see the latency and the decision.

Common outcomes:

| Symptom | Cause |
|---|---|
| `No Skillful hook` for a runtime | Run `skillful install`. The runtime's config directory must exist. |
| Injects the reminder line every time | `TYPESAFE_API_KEY` is missing or rejected. |
| `Catalog: 0 entries` | No skills, MCP servers or agents found. Install some, or check for a custom home directory. |
| Hook never fires in Codex | The trust ledger. See the Codex caveat above. |
| Nothing injected for a prompt that should match | Either the prompt genuinely needed no capability, or the capability did not make the shortlist. Run `skillful route --prompt "..." --explain` to see the shortlist and the scores. |

`skillful route` runs the same decision path as the hook, with the internals visible. It is the
right tool for "why did it pick that?".
