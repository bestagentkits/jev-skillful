import type { CatalogKind, CatalogRuntime } from "../core/index.js";
import { CATALOG_KINDS, CATALOG_RUNTIMES, scanCatalog } from "../core/index.js";

export interface CatalogCommandOptions {
  json: boolean;
  kinds: CatalogKind[];
  runtimes: CatalogRuntime[];
  summary: boolean;
}

/**
 * `skillful catalog` — print every capability Skillful can see.
 *
 * This is the phase-1 surface: it makes the scanner inspectable before any
 * routing or hook machinery exists, which is what makes the scanner debuggable.
 */
export async function catalogCommand(options: CatalogCommandOptions): Promise<number> {
  const catalog = await scanCatalog(
    options.runtimes.length > 0 ? { runtimes: options.runtimes } : {},
  );

  const entries =
    options.kinds.length > 0
      ? catalog.entries.filter((entry) => options.kinds.includes(entry.kind))
      : catalog.entries;

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          fingerprint: catalog.fingerprint,
          count: entries.length,
          warnings: catalog.warnings,
          entries,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  if (options.summary) {
    printSummary(entries, catalog.fingerprint, catalog.warnings);
    return 0;
  }

  for (const entry of entries) {
    const flags = entry.degraded === true ? " [degraded]" : "";
    const scope = entry.scope === "project" ? " (project)" : "";
    const suffix = entry.description === "" ? "" : ` — ${entry.description}`;
    process.stdout.write(
      `${entry.kind.padEnd(7)} ${entry.runtime.padEnd(11)}${scope.padEnd(10)} ${entry.name}${flags}${suffix}\n`,
    );
  }
  printFooter(entries.length, catalog.fingerprint, catalog.warnings);
  return 0;
}

function printSummary(
  entries: readonly { kind: CatalogKind; runtime: CatalogRuntime; degraded?: boolean }[],
  fingerprint: string,
  warnings: readonly string[],
): void {
  const byRuntime = new Map<string, number>();
  const byKind = new Map<string, number>();
  let degraded = 0;

  for (const entry of entries) {
    byRuntime.set(entry.runtime, (byRuntime.get(entry.runtime) ?? 0) + 1);
    byKind.set(entry.kind, (byKind.get(entry.kind) ?? 0) + 1);
    if (entry.degraded === true) degraded += 1;
  }

  process.stdout.write(`Total: ${entries.length} entries\n\n`);
  process.stdout.write("By runtime:\n");
  for (const runtime of CATALOG_RUNTIMES) {
    process.stdout.write(`  ${runtime.padEnd(12)} ${byRuntime.get(runtime) ?? 0}\n`);
  }
  process.stdout.write("\nBy kind:\n");
  for (const kind of CATALOG_KINDS) {
    process.stdout.write(`  ${kind.padEnd(12)} ${byKind.get(kind) ?? 0}\n`);
  }
  if (degraded > 0) {
    process.stdout.write(`\nDegraded entries (no readable description): ${degraded}\n`);
  }
  printFooter(entries.length, fingerprint, warnings);
}

function printFooter(
  count: number,
  fingerprint: string,
  warnings: readonly string[],
): void {
  process.stdout.write(`\n${count} entries · fingerprint ${fingerprint}\n`);
  for (const warning of warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }
}
