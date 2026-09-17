# Telemetry

Skillful writes a local log of routing decisions so a report can be produced later. The log never
leaves your machine. There is no upload, no analytics service, and no update check.

## Where it lives

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/skillful/events.jsonl` |
| Linux | `$XDG_STATE_HOME/skillful/events.jsonl`, or `~/.local/state/skillful/events.jsonl` |
| Windows | `%LOCALAPPDATA%\skillful\events.jsonl` |

It is in the state directory rather than the cache directory on purpose. The cache is disposable:
deleting it costs one round trip. The log is not: it is the only record of what the router decided,
and deleting it destroys the history that made the tool worth measuring.

The file is written `0600`.

## What is recorded, and what is not

Every event is one JSON object on one line. Two kinds exist.

**`route`** — one per routing decision. It carries the prompt's hash and character count, the
catalog fingerprint, the shortlist, the decision and its reason, the latency, whether the cache was
hit, and token counts.

**`capability-used`** — one when an agent actually used a capability. This is a separate event
because without it a poor outcome cannot be attributed: it is either "the router chose wrong" or
"the agent ignored a good suggestion", and those need completely different fixes.

**Never recorded:**

- Prompt text. Only a SHA-256 hash and a character count. The hash is enough to correlate a later
  observation and not enough to read what you typed.
- The API key, or any environment value.
- Absolute paths of anything.

The `reason` field on a route event is drawn from a fixed vocabulary produced by the router —
`heuristic`, `none-won`, `below-threshold`, `empty-shortlist`, or a degraded cause such as `timeout`
or `auth`. It is never free text from a prompt.

Capability *names* are recorded, and a capability name can identify a private project. That is why
the report carries a warning before you share it.

## The log cannot break anything

Telemetry runs on the hook's path, on a two-second budget. Every failure — a full disk, a read-only
directory, a permission error, a serialisation bug — is a silent no-op. A writer never throws, and
nothing about routing depends on a write succeeding.

Writes are a single append of one line. On POSIX an append of a small buffer to a file opened
`O_APPEND` is atomic, so two hooks writing at the same instant produce two intact lines rather than
one interleaved line. Lines are bounded at 16KB, well below any platform's atomic-write limit, and a
line that would exceed the bound is dropped rather than written.

## Rotation and retention

- The active log rotates at 16MB, keeping three rotated files.
- Rotated logs older than 30 days are deleted.
- Maintenance runs roughly every 200th write, not on every write, so the hook does not pay a `stat`
  call per prompt.

## Turning it off

```bash
skillful telemetry --disable     # prints the line to add to your shell profile
skillful telemetry --enable      # prints the line to remove
```

The switch is an environment variable:

```bash
export SKILLFUL_TELEMETRY=0
```

Skillful does not write to your shell profile itself. The change is yours to make and yours to see.

## Reading the log

```bash
skillful report                  # write the HTML report to its default path
skillful dashboard               # the same, and open it
skillful report --html ./r.html  # choose the path
skillful report --max-bytes 5000000   # read only the tail of a large log
```

The report is a single self-contained HTML file. No stylesheet link, no script tag, no font, no
image, no network request of any kind. It opens from disk, offline, which is the only environment it
is guaranteed to be read in.

A malformed line is skipped rather than fatal, and **the number of skipped lines is reported in the
report header and in the appendix**. Silently dropping data and then presenting statistics computed
from what remains is how a measurement system lies without anyone intending it to.

## `--include-prompts`

Off by default. It adds prompt text to the report, which is the one thing you may not want in a file
you might share. When a report was generated with it, the report itself says so in the appendix.
