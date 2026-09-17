# Architecture

Skillful resolves the capabilities installed on a machine against the prompt the user just typed,
then injects a short recommendation into the agent's context. This document records the surfaces it
reads and the measurements taken while building it. It is written from what was verified on a real
machine, not from documentation alone.

## Pipeline

```text
prompt
  |
  +-- hook (per runtime)          reads the prompt, consults the cache, applies a 2000ms budget
  |
  +-- catalog scan (local)        reads 4 surfaces across 4 runtimes; no network
  |
  +-- router (one Jev request)    BM25 shortlist -> one `choice` question plus per-candidate `noul`
  |
  +-- inject                      at most 1 primary + 2 runner-ups, or nothing at all
```

## Catalog surfaces

Every supported runtime keeps the same kinds of things in similar layouts. The scanner reads all of
them and normalises the result into one entry shape.

| Runtime | Kind | Where it is read from |
|---|---|---|
| claude-code | skill | `~/.claude/skills/<name>/SKILL.md`, `<project>/.claude/skills`, and `~/.claude/plugins/**` |
| claude-code | agent | `~/.claude/agents/<name>.md`, `<project>/.claude/agents` |
| claude-code | command | `~/.claude/commands/**/<name>.md` (nested paths become `parent:name`) |
| claude-code | mcp | `~/.claude.json` under `mcpServers` and `projects[<path>].mcpServers`, plus `<project>/.mcp.json`, plus `~/.claude/mcp.json` |
| codex | skill | `$AGENTKIT_CODEX_SKILLS_ROOT`, else `~/.agents/skills/<name>/SKILL.md`, plus `<project>/.agents/skills` |
| codex | agent | `~/.codex/agents/<name>.toml` (top-level `name` and `developer_instructions`) |
| codex | mcp | `~/.codex/config.toml` `[mcp_servers.<name>]` tables, plus `<project>/.codex/config.toml` |
| pi | skill | `~/.pi/agent/skills/<name>/SKILL.md`, `<project>/.pi/skills` |
| pi | agent | `~/.pi/agent/agents/<name>.md`, `<project>/.pi/agents` |
| pi | rule | `~/.pi/agent/rules/<name>.md` |
| pi | mcp | `~/.pi/agent/mcp.json`, `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json`, `~/.config/mcp/mcp.json`, `<project>/.pi/mcp.json`, `<project>/.mcp.json` |
| omp | skill | `~/.omp/agent/skills/<name>/SKILL.md`, `~/.omp/agent/managed-skills/<name>/SKILL.md`, `<project>/.omp/skills` |
| omp | agent | `~/.omp/agent/agents/<name>.md` |
| omp | rule | `~/.omp/agent/rules/<name>.md`, `<project>/.omp/rules` |
| omp | mcp | `~/.omp/agent/mcp.json`, `<project>/.omp/mcp.json` |

The Oh My Pi home directory follows the same precedence the AgentKit adapter uses:
`AGENTKIT_OMP_HOME`, then `OMP_HOME` or `PI_CODING_AGENT_DIR`, then `~/.omp/agent`, then `~/.omp`.

### Probe results

Two surfaces were not where the documentation suggested, so they were read out of the owning source
code instead of guessed:

- **Pi has no MCP configuration file of its own.** MCP is provided by the `pi-mcp-adapter` package,
  which reads a shared set of locations. The paths above were taken from that package's `config.ts`.
- **Codex keeps skills outside `~/.codex`.** Skills live in the shared `~/.agents/skills` root that
  other `agents`-convention clients also use, which is why an empty `~/.codex/skills` is expected.

One surface is still open and is probed in phase 4: whether Codex reads hooks from `~/.codex/hooks.json`
or from `[hooks.<event>]` tables in `~/.codex/config.toml`. Both files exist, and AgentKit writes both.

## Identity and fingerprint

An entry's id is `runtime:kind:scope:name`. It deliberately excludes the filesystem path, so moving a
skills directory does not change the identity of anything inside it.

The catalog fingerprint is a sha256 over the sorted `kind:runtime:scope:name:description` of every
entry. It is one half of the route cache key, so it must change when the meaning of the catalog changes
and stay stable when incidental details do. Reordering files does not change it; adding, removing,
renaming, or re-describing an entry does. Paths are excluded for the same reason ids are.

## Measured behaviour

Measurements taken on the development machine while building phase 1.

| Measurement | Result |
|---|---|
| Catalog size on the development machine | 597 entries: 139 claude-code, 154 codex, 130 pi, 174 omp |
| Catalog by kind | 5 mcp surfaces, 72 agents, 16 rules, plus skills and commands |
| Scan duration (node, warm) | 0.14 – 0.27s for the full catalog plus JSON serialisation |
| Jev request latency, K=5 (4 questions) | 0.745 – 0.858s |
| Jev request latency, K=15 (2 questions) | 0.686 – 0.762s |
| Jev request cost | ~1360 input tokens, about $0.00006 per route |

Two consequences shape the design:

- **Latency does not grow with shortlist size.** K=5 and K=15 cost the same, because the fixed
  connection and inference overhead dominates. The 2000ms hook budget therefore has room, and a larger
  shortlist costs quality nothing in latency.
- **Scan duration is not the bottleneck.** A warm scan is roughly a quarter of the budget, which is why
  the hook can afford to scan when the cache misses.

## Design constraints that came from measurement

**Do not use a `noul` question as a gate for "does this task need a capability".** Measured live: the
noul returned 0.39 for a task where the `choice` question had already picked the right capability with
confidence 1.0, and returned 0.10 for both "fix the typo" and "thanks", so it could not tell them apart.
The `none` option inside the `choice` question already handles abstention correctly (chitchat gave a
`none` probability of 1.00, the typo case 0.62). Dropping the gate removes a question, a branch, and a
failure mode.

**Inject at most one primary plus two runner-ups.** K is the size of the shortlist the router reasons
over, not the amount of text injected into the agent. Injecting the whole shortlist would recreate the
"enumerate every skill in the context window" strategy that arXiv:2604.24594 shows does not scale: as
the corpus grows, the agent becomes *less* accurate at picking the right skill.

## Verification notes

The TypeScript 7 toolchain required two adjustments that are easy to get wrong:

- `types: ["node"]` must be set explicitly. TypeScript 7 does not pick up `@types/node` through the
  `@types` walk for these packages, and without it every `node:` import reports TS2591.
- `baseUrl` was **removed** in TypeScript 7 and reports TS5102. The `paths` entries that map
  `@skillful/core` to its source must be declared without it; in TypeScript 7 the substitution values
  resolve relative to the config file that declares them.

The build uses `tsconfig.build.json`, which excludes test files so nothing test-related reaches `dist`.
The editor and `pnpm typecheck` use `tsconfig.json`, which **includes** the test files deliberately:
excluded test files get analysed outside the project and lose the `types` and lib settings they need,
which shows up as spurious `TS2591` errors for `node:` imports.

### Why this is a single package

Skillful is one package (`packages/cli`, published as `skillful`), not a core/cli split.

The first attempt used two workspace packages with the CLI importing `@skillful/core` as a bare
specifier. `tsc` resolved it (through project references, and independently through the pnpm workspace
link), but the editor's TypeScript language server did not, reporting `TS2307` plus cascading `TS7006`
errors on every edit. That split was speculative anyway: `@skillful/core` was `private`, had exactly one
consumer, and nothing shipped it separately.

Collapsing to one package removes the bare workspace specifier entirely, and with it the project
references, the build-ordering requirement, and a `deno.json` import map that had been added as a
workaround. The router, telemetry, and benchmark code all live under `src/core/` and are imported with
relative paths, which every resolver agrees on.

A second lesson from the same episode: the language server was correct, and calling its diagnostics a
"stale cache" was wrong three times. When editor diagnostics and the compiler disagree, neither side is
presumed right — the disagreement has to be explained, and here the explanation was a real resolution
gap rather than a tool defect.
