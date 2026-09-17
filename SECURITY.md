# Security

## Reporting a vulnerability

Use [GitHub's private advisory form](https://github.com/bestagentkits/jev-skillful/security/advisories/new).
Please do not open a public issue for a vulnerability.

Include what you did, what happened, and what you expected. A proof of concept is welcome.

## Threat model

Skillful runs on a developer's machine, inside their agent, and writes into configuration files
that other tools also use. The risks worth stating plainly are these.

### Extensions run with your full user permissions

`skillful install` writes an extension for Pi and OMP at
`~/.{pi,omp}/agent/extensions/skillful/index.ts`. Pi and OMP extensions execute arbitrary code with
the full permissions of the user who runs the agent. That is the platform's design, not something
this project can change.

The extension Skillful writes is about forty lines: it spawns the Skillful CLI on a child process,
writes one JSON object to its stdin, reads one JSON object from its stdout, and injects the
`additionalContext` field if there is one. It does nothing else, and it is readable in full. Read it
before you trust it. If you are not comfortable with that, do not install for Pi or OMP; the Claude
Code and Codex hooks are plain command hooks and do not carry the same weight.

### Your prompt is transmitted

`skillful route` sends the prompt to `api.typesafe.ai`, truncated to 1000 characters. This is the
mechanism of the product: the model decides which capability a task needs, and it needs to read the
task. The request carries the shortlisted capability names and descriptions alongside the prompt.

- Set `SKILLFUL_UPLOAD_PROMPT=false` to withhold the prompt text. The shortlist is still chosen
  locally from your prompt, so routing quality drops; nothing else changes.
- The prompt is truncated before it is sent.
- This is the only outbound network call Skillful makes. There is no telemetry, no analytics, no
  phone-home, and no update check.

The API key is read from `TYPESAFE_API_KEY` and nowhere else. A config file that contains a
credential-shaped key is rejected with a warning, because a key written into a file should be
treated as leaked.

### Configuration files

`skillful install` modifies `~/.claude/settings.json` and `~/.codex/hooks.json`, both of which other
tools write to. The protections are:

- A timestamped backup before any modification.
- A file that cannot be parsed is reported and left alone. It is never overwritten.
- Only entries carrying Skillful's own marker are touched. Every other hook keeps its position.
- Writes are atomic: a temp file, then a rename.
- Uninstall removes only what install added, and removes the file if it held nothing else.

If install ever damages a configuration file, that is a security-relevant bug. Report it.

### The Codex trust ledger

Codex keeps `~/.codex/config.toml` `[hooks.state]`, a ledger mapping hook script paths to a
`trusted_hash`. Skillful installs into `~/.codex/hooks.json` and **does not write to that ledger**.
Fabricating a trust entry would mean authorising its own code inside another tool's security model
without asking you. If the hook does not fire in Codex, approve it once when Codex prompts.

### The route cache

`~/.cache/skillful/routes.json` stores routing decisions, keyed by a hash of the normalised prompt
and the catalog fingerprint. It is written with mode `0600`.

- It never stores prompt text.
- It never stores an API key or any credential.
- It can be deleted at any time; the next prompt simply misses the cache.
- A corrupt cache file is treated as empty rather than as an error.

### Exported cases

`skillful export-case` redacts before writing: home directories become `~`, other absolute paths
become `<path>`, environment values whose names look sensitive become `<redacted-env>`, and
credential shapes, URL credentials, and email addresses are removed. Tests assert on these, using
the exact strings a real machine produces.

The redaction is a filter, and a filter can miss something. Read the output before posting it.

## Supported versions

The latest published version on npm. Fixes are released as patch versions.
