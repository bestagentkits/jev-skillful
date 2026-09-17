import { CATALOG_KINDS, CATALOG_RUNTIMES } from "./core/index.js";
import type { CatalogKind, CatalogRuntime } from "./core/index.js";
import { benchCommand } from "./commands/bench.js";
import { catalogCommand } from "./commands/catalog.js";
import { doctorCommand } from "./commands/doctor.js";
import { evalCommand } from "./commands/eval.js";
import { exportCaseCommand } from "./commands/export-case.js";
import { hookCommand } from "./commands/hook.js";
import { installCommand, uninstallCommand } from "./commands/install.js";
import { reportCommand, telemetryCommand } from "./commands/report.js";
import { routeCommand } from "./commands/route.js";

const USAGE = `skillful — capability router for coding agents

Usage:
  skillful install [options]        Install the hook for every agent runtime present
  skillful uninstall [options]      Remove the Skillful hook, leaving other hooks alone
  skillful doctor [options]         Report whether the hook actually works
  skillful hook                      Hook entry point. Reads event JSON on stdin
  skillful export-case [options]     Export a redacted routing case for a bug report
  skillful report [options]          Write a self-contained HTML report
  skillful dashboard [options]       Write the report to its default path and open it
  skillful telemetry [options]       Show or explain the telemetry switch
  skillful bench [options]           Run the outcome benchmark (A/B, paired)
  skillful catalog [options]        List every capability found on this machine
  skillful route --prompt <text>    Decide which capability a prompt needs
  skillful eval [options]           Score the router against an eval fixture set

Install options:
  --runtime <runtime>    Only install for these runtimes (repeatable)
  --dry-run              Report what would change without writing anything
  --json                 Emit machine-readable JSON

Doctor options:
  --offline              Skip the live route trial (no key or network needed)
  --json                 Emit machine-readable JSON

Catalog options:
  --json                 Emit machine-readable JSON
  --summary              Show counts by runtime and kind
  --kind <kind>          Filter by kind (repeatable): ${CATALOG_KINDS.join(", ")}
  --runtime <runtime>    Filter by runtime (repeatable): ${CATALOG_RUNTIMES.join(", ")}

Route options:
  --prompt <text>        The prompt to route, or omit and pipe it on stdin
  --json                 Emit the full RouteResult as JSON
  --explain              Show the shortlist, BM25 scores and noul ranking
  --model <id>           Override the TypeSafe model (default jev-latest)
  --no-prompt-upload     Send only the catalog, never the prompt text

Eval options:
  --fixtures <file>      Fixture JSONL (default bench/fixtures/routing.jsonl)
  --corpus <file>        Corpus snapshot (default bench/corpus/distractors.json)
  --repeat <n>           Routes per fixture, for the stability metric (default 1)
  --limit <n>            Use only the first n fixtures, for fast iterations
  --sweep                Sweep noneThreshold and skill quota instead of one run
  --recall-only          Sweep quotas and report recall@K. No API call, no key, no cost
  --replay <file>        Answer from recorded responses, no key and no network
  --record <file>        Record live responses for later --replay
  --snapshot-corpus <f>  Scan the catalog and write a corpus snapshot, then exit
  --include-private      Keep private-project entries in the snapshot
  --json                 Emit the full report as JSON
  --explain              Print the full Markdown report

Global:
  -h, --help             Show this help
  --version              Show the version

Environment:
  TYPESAFE_API_KEY             TypeSafe API key. Read only from the environment.
  SKILLFUL_MODEL               Override the model
  SKILLFUL_BUDGET_MS           Override the routing budget in milliseconds
  SKILLFUL_UPLOAD_PROMPT       Set to false to never transmit prompt text
  AGENTKIT_CODEX_SKILLS_ROOT   Override the shared Codex/agents skills root
  AGENTKIT_OMP_HOME, OMP_HOME  Override the Oh My Pi home directory

Configuration file:
  ~/.config/skillful/config.json   Thresholds and quota groups. Never a credential.
`;

export const VERSION = "0.2.0";

/** Dispatch a parsed command line. Returns the process exit code. */
export async function run(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === "--version" || command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (command === "install" || command === "uninstall") {
    const parsed = parseInstallFlags(rest);
    if (parsed.error !== undefined) {
      process.stderr.write(`${parsed.error}\n\n${USAGE}`);
      return 1;
    }
    if (parsed.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    const options = {
      json: parsed.json,
      dryRun: parsed.dryRun,
      ...(parsed.runtimes.length === 0 ? {} : { runtimes: parsed.runtimes }),
    };
    return command === "install" ? installCommand(options) : uninstallCommand(options);
  }

  if (command === "doctor") {
    const parsed = parseDoctorFlags(rest);
    if (parsed.error !== undefined) {
      process.stderr.write(`${parsed.error}\n\n${USAGE}`);
      return 1;
    }
    if (parsed.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    return doctorCommand({ json: parsed.json, offline: parsed.offline });
  }

  if (command === "export-case") {
    const parsed = parseExportCaseFlags(rest);
    if (parsed.error !== undefined) {
      process.stderr.write(`${parsed.error}\n\n${USAGE}`);
      return 1;
    }
    if (parsed.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    return exportCaseCommand({
      ...(parsed.prompt === undefined ? {} : { prompt: parsed.prompt }),
      ...(parsed.hash === undefined ? {} : { hash: parsed.hash }),
      json: parsed.json,
    });
  }

  if (command === "hook") {
    // No flags and no error path. This command is called by an agent runtime on every prompt,
    // so it always exits 0 and always writes exactly one JSON object to stdout.
    return hookCommand({ stdin: await readStdinRaw() });
  }

  if (command === "bench") {
    const parsed = parseBenchFlags(rest);
    if (parsed.error !== undefined) {
      process.stderr.write(`${parsed.error}\n\n${USAGE}`);
      return 1;
    }
    if (parsed.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    return benchCommand({
      repeat: parsed.repeat,
      pilot: parsed.pilot,
      probe: parsed.probe,
      dryRun: parsed.dryRun,
      json: parsed.json,
      ...(parsed.suite === undefined ? {} : { suite: parsed.suite }),
      ...(parsed.tasks === undefined ? {} : { tasks: parsed.tasks }),
      ...(parsed.runtime === undefined ? {} : { runtime: parsed.runtime }),
      ...(parsed.outDir === undefined ? {} : { outDir: parsed.outDir }),
      ...(parsed.maxTasks === undefined ? {} : { maxTasks: parsed.maxTasks }),
    });
  }

  if (command === "report" || command === "dashboard") {
    const parsed = parseReportFlags(rest);
    if (parsed.error !== undefined) {
      process.stderr.write(`${parsed.error}\n\n${USAGE}`);
      return 1;
    }
    if (parsed.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    return reportCommand({
      ...(parsed.html === undefined ? {} : { html: parsed.html }),
      ...(parsed.maxBytes === undefined ? {} : { maxBytes: parsed.maxBytes }),
      includePrompts: parsed.includePrompts,
      json: parsed.json,
      // The dashboard variant is the same command with a default path and a browser.
      open: command === "dashboard" ? true : parsed.open,
    });
  }

  if (command === "telemetry") {
    const parsed = parseTelemetryFlags(rest);
    if (parsed.error !== undefined) {
      process.stderr.write(`${parsed.error}\n\n${USAGE}`);
      return 1;
    }
    if (parsed.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    return telemetryCommand(parsed.set === undefined ? {} : { set: parsed.set });
  }

  if (command === "catalog") {
    const parsed = parseCatalogFlags(rest);
    if (parsed.error !== undefined) {
      process.stderr.write(`${parsed.error}\n\n${USAGE}`);
      return 1;
    }
    if (parsed.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    return catalogCommand({
      json: parsed.json,
      summary: parsed.summary,
      kinds: parsed.kinds,
      runtimes: parsed.runtimes,
    });
  }

  if (command === "route") {
    const parsed = parseRouteFlags(rest);
    if (parsed.error !== undefined) {
      process.stderr.write(`${parsed.error}\n\n${USAGE}`);
      return 1;
    }
    if (parsed.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    return routeCommand({
      prompt: parsed.prompt ?? (await readStdin()),
      json: parsed.json,
      explain: parsed.explain,
      ...(parsed.model === undefined ? {} : { model: parsed.model }),
      ...(parsed.uploadPrompt === undefined ? {} : { uploadPrompt: parsed.uploadPrompt }),
    });
  }

  if (command === "eval") {
    const parsed = parseEvalFlags(rest);
    if (parsed.error !== undefined) {
      process.stderr.write(`${parsed.error}\n\n${USAGE}`);
      return 1;
    }
    if (parsed.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    return evalCommand({
      ...(parsed.fixtures === undefined ? {} : { fixtures: parsed.fixtures }),
      ...(parsed.corpus === undefined ? {} : { corpus: parsed.corpus }),
      repeat: parsed.repeat,
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      json: parsed.json,
      explain: parsed.explain,
      sweep: parsed.sweep,
      recallOnly: parsed.recallOnly,
      ...(parsed.snapshotCorpus === undefined ? {} : { snapshotCorpus: parsed.snapshotCorpus }),
      includePrivate: parsed.includePrivate,
      ...(parsed.record === undefined ? {} : { record: parsed.record }),
      ...(parsed.replay === undefined ? {} : { replay: parsed.replay }),
      ...(parsed.budgetMs === undefined ? {} : { budgetMs: parsed.budgetMs }),
    });
  }

  process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
  return 1;
}

/**
 * Read stdin verbatim, without the trimming `readStdin` does for prompts.
 *
 * The hook parses its own JSON envelope, and a caller that piped a valid document must be able
 * to hand it over unmodified.
 */
async function readStdinRaw(): Promise<string> {
  if (process.stdin.isTTY === true) return "";

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read a prompt from stdin when one was not passed as a flag.
 *
 * This is the path the runtime hooks will use, so it is supported from the start rather
 * than added later. A TTY with nothing piped in returns undefined instead of hanging.
 */
async function readStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY === true) return undefined;

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text.length > 0 ? text : undefined;
}

// ---------------------------------------------------------------------------
// catalog
// ---------------------------------------------------------------------------

interface ParsedCatalogFlags {
  json: boolean;
  summary: boolean;
  help: boolean;
  kinds: CatalogKind[];
  runtimes: CatalogRuntime[];
  error?: string;
}

function parseCatalogFlags(argv: readonly string[]): ParsedCatalogFlags {
  const out: ParsedCatalogFlags = {
    json: false,
    summary: false,
    help: false,
    kinds: [],
    runtimes: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--json") {
      out.json = true;
    } else if (arg === "--summary") {
      out.summary = true;
    } else if (arg === "-h" || arg === "--help") {
      out.help = true;
    } else if (arg === "--kind" || arg === "--runtime") {
      const value = argv[i + 1];
      if (value === undefined) {
        out.error = `Missing value for ${arg}`;
        return out;
      }
      i += 1;
      const rejected = arg === "--kind"
        ? addKind(out.kinds, value)
        : addRuntime(out.runtimes, value);
      if (rejected !== null) {
        out.error = rejected;
        return out;
      }
    } else {
      out.error = `Unknown option: ${arg}`;
      return out;
    }
  }
  return out;
}

function addKind(target: CatalogKind[], value: string): string | null {
  const match = CATALOG_KINDS.find((kind) => kind === value);
  if (match === undefined) {
    return `Invalid --kind: ${value} (expected one of ${CATALOG_KINDS.join(", ")})`;
  }
  target.push(match);
  return null;
}

function addRuntime(target: CatalogRuntime[], value: string): string | null {
  const match = CATALOG_RUNTIMES.find((runtime) => runtime === value);
  if (match === undefined) {
    return `Invalid --runtime: ${value} (expected one of ${CATALOG_RUNTIMES.join(", ")})`;
  }
  target.push(match);
  return null;
}

// ---------------------------------------------------------------------------
// eval
// ---------------------------------------------------------------------------

interface ParsedEvalFlags {
  fixtures?: string;
  corpus?: string;
  repeat: number;
  limit?: number;
  json: boolean;
  explain: boolean;
  sweep: boolean;
  recallOnly: boolean;
  snapshotCorpus?: string;
  includePrivate: boolean;
  record?: string;
  replay?: string;
  budgetMs?: number;
  help: boolean;
  error?: string;
}

/** Options that consume the following argument. */
const EVAL_VALUE_FLAGS = new Set([
  "--fixtures",
  "--corpus",
  "--repeat",
  "--limit",
  "--snapshot-corpus",
  "--record",
  "--replay",
  "--budget-ms",
]);

function parseEvalFlags(argv: readonly string[]): ParsedEvalFlags {
  const out: ParsedEvalFlags = {
    repeat: 1,
    json: false,
    explain: false,
    sweep: false,
    recallOnly: false,
    includePrivate: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (!EVAL_VALUE_FLAGS.has(arg)) {
      if (arg === "--json") out.json = true;
      else if (arg === "--explain") out.explain = true;
      else if (arg === "--sweep") out.sweep = true;
      else if (arg === "--recall-only") out.recallOnly = true;
      else if (arg === "--include-private") out.includePrivate = true;
      else if (arg === "-h" || arg === "--help") out.help = true;
      else {
        out.error = `Unknown option: ${arg}`;
        return out;
      }
      continue;
    }

    const value = argv[i + 1];
    if (value === undefined) {
      out.error = `Missing value for ${arg}`;
      return out;
    }
    i += 1;

    if (arg === "--fixtures") out.fixtures = value;
    else if (arg === "--corpus") out.corpus = value;
    else if (arg === "--record") out.record = value;
    else if (arg === "--replay") out.replay = value;
    else if (arg === "--snapshot-corpus") out.snapshotCorpus = value;
    else {
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric < 0) {
        out.error = `${arg} expects a non-negative number, got ${value}`;
        return out;
      }
      if (arg === "--repeat") out.repeat = Math.floor(numeric);
      else if (arg === "--limit") out.limit = Math.floor(numeric);
      else out.budgetMs = numeric;
    }
  }

  if (out.record !== undefined && out.replay !== undefined) {
    out.error = "--record and --replay cannot be used together";
  }
  return out;
}

interface ParsedExportCaseFlags {
  prompt?: string;
  hash?: string;
  json: boolean;
  help: boolean;
  error?: string;
}

function parseExportCaseFlags(argv: readonly string[]): ParsedExportCaseFlags {
  const out: ParsedExportCaseFlags = { json: false, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--json") {
      out.json = true;
    } else if (arg === "-h" || arg === "--help") {
      out.help = true;
    } else if (arg === "--prompt" || arg === "--hash") {
      const value = argv[i + 1];
      if (value === undefined) {
        out.error = `Missing value for ${arg}`;
        return out;
      }
      i += 1;
      if (arg === "--prompt") out.prompt = value;
      else out.hash = value;
    } else {
      out.error = `Unknown option: ${arg}`;
      return out;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// install / uninstall / doctor
// ---------------------------------------------------------------------------

interface ParsedInstallFlags {
  json: boolean;
  dryRun: boolean;
  runtimes: CatalogRuntime[];
  help: boolean;
  error?: string;
}

function parseInstallFlags(argv: readonly string[]): ParsedInstallFlags {
  const out: ParsedInstallFlags = { json: false, dryRun: false, runtimes: [], help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--json") {
      out.json = true;
    } else if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg === "-h" || arg === "--help") {
      out.help = true;
    } else if (arg === "--runtime") {
      const value = argv[i + 1];
      if (value === undefined) {
        out.error = `Missing value for ${arg}`;
        return out;
      }
      i += 1;
      const rejected = addRuntime(out.runtimes, value);
      if (rejected !== null) {
        out.error = rejected;
        return out;
      }
    } else {
      out.error = `Unknown option: ${arg}`;
      return out;
    }
  }

  return out;
}

interface ParsedDoctorFlags {
  json: boolean;
  offline: boolean;
  help: boolean;
  error?: string;
}

function parseDoctorFlags(argv: readonly string[]): ParsedDoctorFlags {
  const out: ParsedDoctorFlags = { json: false, offline: false, help: false };

  for (const arg of argv) {
    if (arg === "--json") out.json = true;
    else if (arg === "--offline") out.offline = true;
    else if (arg === "-h" || arg === "--help") out.help = true;
    else {
      out.error = `Unknown option: ${arg}`;
      return out;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// bench
// ---------------------------------------------------------------------------

interface ParsedBenchFlags {
  suite?: string;
  tasks?: string[];
  repeat: number;
  pilot: boolean;
  probe: boolean;
  runtime?: string;
  outDir?: string;
  maxTasks?: number;
  dryRun: boolean;
  json: boolean;
  help: boolean;
  error?: string;
}

function parseBenchFlags(argv: readonly string[]): ParsedBenchFlags {
  const out: ParsedBenchFlags = {
    repeat: 1,
    pilot: false,
    probe: false,
    dryRun: false,
    json: false,
    help: false,
  };
  const tasks: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--pilot") out.pilot = true;
    else if (arg === "--probe") out.probe = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "-h" || arg === "--help") out.help = true;
    else if (
      arg === "--suite" ||
      arg === "--task" ||
      arg === "--runtime" ||
      arg === "--out" ||
      arg === "--max-tasks" ||
      arg === "--repeat"
    ) {
      const value = argv[i + 1];
      if (value === undefined) {
        out.error = `Missing value for ${arg}`;
        return out;
      }
      i += 1;
      if (arg === "--suite") out.suite = value;
      else if (arg === "--task") tasks.push(value);
      else if (arg === "--runtime") out.runtime = value;
      else if (arg === "--out") out.outDir = value;
      else {
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || numeric < 1) {
          out.error = `${arg} expects a positive number, got ${value}`;
          return out;
        }
        if (arg === "--max-tasks") out.maxTasks = Math.floor(numeric);
        else out.repeat = Math.floor(numeric);
      }
    } else {
      out.error = `Unknown option: ${arg}`;
      return out;
    }
  }

  if (tasks.length > 0) out.tasks = tasks;
  return out;
}

// ---------------------------------------------------------------------------
// report / dashboard / telemetry
// ---------------------------------------------------------------------------

interface ParsedReportFlags {
  html?: string;
  maxBytes?: number;
  open: boolean;
  includePrompts: boolean;
  json: boolean;
  help: boolean;
  error?: string;
}

function parseReportFlags(argv: readonly string[]): ParsedReportFlags {
  const out: ParsedReportFlags = {
    open: false,
    includePrompts: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--open") out.open = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--include-prompts") out.includePrompts = true;
    else if (arg === "-h" || arg === "--help") out.help = true;
    else if (arg === "--html" || arg === "--max-bytes") {
      const value = argv[i + 1];
      if (value === undefined) {
        out.error = `Missing value for ${arg}`;
        return out;
      }
      i += 1;
      if (arg === "--html") out.html = value;
      else {
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || numeric <= 0) {
          out.error = `${arg} expects a positive number, got ${value}`;
          return out;
        }
        out.maxBytes = Math.floor(numeric);
      }
    } else {
      out.error = `Unknown option: ${arg}`;
      return out;
    }
  }

  return out;
}

interface ParsedTelemetryFlags {
  set?: "enable" | "disable";
  help: boolean;
  error?: string;
}

function parseTelemetryFlags(argv: readonly string[]): ParsedTelemetryFlags {
  const out: ParsedTelemetryFlags = { help: false };

  for (const arg of argv) {
    if (arg === "--disable") out.set = "disable";
    else if (arg === "--enable") out.set = "enable";
    else if (arg === "-h" || arg === "--help") out.help = true;
    else {
      out.error = `Unknown option: ${arg}`;
      return out;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// route
// ---------------------------------------------------------------------------

interface ParsedRouteFlags {
  prompt?: string;
  json: boolean;
  explain: boolean;
  help: boolean;
  model?: string;
  uploadPrompt?: boolean;
  error?: string;
}

function parseRouteFlags(argv: readonly string[]): ParsedRouteFlags {
  const out: ParsedRouteFlags = { json: false, explain: false, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--json") {
      out.json = true;
    } else if (arg === "--explain") {
      out.explain = true;
    } else if (arg === "-h" || arg === "--help") {
      out.help = true;
    } else if (arg === "--no-prompt-upload") {
      out.uploadPrompt = false;
    } else if (arg === "--prompt" || arg === "--model") {
      const value = argv[i + 1];
      if (value === undefined) {
        out.error = `Missing value for ${arg}`;
        return out;
      }
      i += 1;
      if (arg === "--prompt") {
        out.prompt = value;
      } else {
        out.model = value;
      }
    } else {
      out.error = `Unknown option: ${arg}`;
      return out;
    }
  }

  return out;
}
