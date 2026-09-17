import { CATALOG_KINDS, CATALOG_RUNTIMES } from "./core/index.js";
import type { CatalogKind, CatalogRuntime } from "./core/index.js";
import { catalogCommand } from "./commands/catalog.js";

const USAGE = `skillful — capability router for coding agents

Usage:
  skillful catalog [options]     List every capability found on this machine

Options:
  --json                 Emit machine-readable JSON
  --summary              Show counts by runtime and kind
  --kind <kind>          Filter by kind (repeatable): ${CATALOG_KINDS.join(", ")}
  --runtime <runtime>    Filter by runtime (repeatable): ${CATALOG_RUNTIMES.join(", ")}
  -h, --help             Show this help

Environment:
  AGENTKIT_CODEX_SKILLS_ROOT   Override the shared Codex/agents skills root
  AGENTKIT_OMP_HOME, OMP_HOME  Override the Oh My Pi home directory
`;

export const VERSION = "0.0.0";

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
  if (command !== "catalog") {
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
    return 1;
  }

  const parsed = parseCatalogFlags(rest);
  if (parsed.error !== undefined) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 1;
  }
  if (parsed.help === true) {
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
