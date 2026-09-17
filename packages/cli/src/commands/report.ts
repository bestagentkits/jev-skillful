/**
 * `skillful report` and `skillful dashboard`.
 *
 * Both read the local event log and write one self-contained HTML file. The only difference is that
 * `dashboard` picks the default path and can open the result, so they share the implementation.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { summarise } from "../core/telemetry/aggregate.js";
import { loadBenchOutcome, redactReport, renderDashboard } from "../core/telemetry/dashboard.js";
import { defaultReportPath, eventsPath, stateDir } from "../core/telemetry/paths.js";
import { readEvents } from "../core/telemetry/reader.js";
import { ensureStateDir } from "../core/telemetry/writer.js";
import { redactText } from "../core/redact.js";
import { DEFAULT_GATE, evaluateGate, type GateResult } from "../core/eval/report.js";
import type { EvalReport } from "../core/eval/run.js";

export interface ReportCommandOptions {
  homeDir?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Where to write the HTML. */
  html?: string;
  /** Read at most this many bytes from the tail of the log. */
  maxBytes?: number;
  /** Open the report after writing it. */
  open?: boolean;
  includePrompts?: boolean;
  platform?: NodeJS.Platform;
  json?: boolean;
}

/** Load the latest eval report if one was written, so section 2 has data. */
function loadEvalReport(homeDir: string): EvalReport | null {
  try {
    const raw = readFileSync(path.join(homeDir, ".cache", "skillful", "last-eval.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    // A file without an `aggregate` is not a usable report, and rendering section 2 from it would
    // mean drawing a gate table from nothing.
    if ((parsed as { aggregate?: unknown }).aggregate === undefined) return null;
    return parsed as EvalReport;
  } catch {
    return null;
  }
}

export async function reportCommand(options: ReportCommandOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env["HOME"] ?? ".";
  const pathCtx = {
    homeDir,
    env,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  };

  const logPath = eventsPath(pathCtx);
  const read = readEvents(logPath, options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes });
  const summary = summarise(read.events, {
    skippedLines: read.skipped,
    totalLines: read.totalLines,
  });

  const evalReport = loadEvalReport(homeDir);
  const gate: GateResult | null = evalReport === null ? null : evaluateGate(evalReport, DEFAULT_GATE);

  const bench = loadBenchOutcome(path.join(stateDir(pathCtx), "bench-outcome.json"));

  let html = renderDashboard({
    summary,
    events: read.events,
    gate,
    bench,
    generatedAt: new Date(),
    homeDir,
    includePrompts: options.includePrompts === true,
  });

  // Redaction runs over the finished document rather than over each field, so a value added to a
  // section later cannot bypass it.
  html = redactReport(html, homeDir);

  if (options.json === true) {
    process.stdout.write(
      `${JSON.stringify({ summary, gate, bench: bench === null ? null : "present", skippedLines: read.skipped }, null, 2)}\n`,
    );
    return 0;
  }

  const outPath = options.html ?? defaultReportPath(pathCtx);
  ensureStateDir(path.dirname(outPath));

  try {
    writeFileSync(outPath, html, "utf8");
  } catch (error) {
    process.stderr.write(`Could not write ${outPath}: ${(error as Error).message}\n`);
    return 1;
  }

  const lines = [
    `Report written to ${redactText(outPath, { homeDir })}`,
    `  from ${read.events.length} events (${read.skipped} unreadable lines of ${read.totalLines})`,
    `  log: ${redactText(logPath, { homeDir })}`,
  ];
  if (read.warnings.length > 0) {
    for (const warning of read.warnings) lines.push(`  note: ${warning}`);
  }
  if (bench === null) {
    lines.push("  sections 5 and 6 show 'not run': the outcome benchmark has not been executed.");
  }
  process.stdout.write(`${lines.join("\n")}\n`);

  if (options.open === true) openInBrowser(outPath);
  return 0;
}

/**
 * Open the report in the user's browser.
 *
 * Spawned detached and with stdio ignored, so a failure to open a window cannot fail the command
 * that produced the file the user asked for.
 */
function openInBrowser(filePath: string): void {
  try {
    const command =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    const child = spawn(command, [filePath], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Opening a browser is a convenience, not part of the result.
  }
}

export interface TelemetryCommandOptions {
  homeDir?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** `--disable` or `--enable`; omitted means report the current state. */
  set?: "enable" | "disable";
  platform?: NodeJS.Platform;
}

/**
 * `skillful telemetry`.
 *
 * There is no config file to edit, because the switch is an environment variable the hook already
 * reads. The command therefore reports what the current environment resolves to and tells the user
 * how to change it, rather than pretending to write a setting it does not own.
 */
export async function telemetryCommand(options: TelemetryCommandOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env["HOME"] ?? ".";
  const pathCtx = {
    homeDir,
    env,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  };

  const disabled =
    env["SKILLFUL_TELEMETRY"] !== undefined &&
    ["0", "false", "off", "no"].includes(String(env["SKILLFUL_TELEMETRY"]).trim().toLowerCase());

  const out: string[] = [];
  out.push(`Telemetry is ${disabled ? "disabled" : "enabled"} in this environment.`);
  out.push(`  log: ${redactText(eventsPath(pathCtx), { homeDir })}`);

  if (options.set !== undefined) {
    out.push("");
    out.push(
      options.set === "disable"
        ? "To disable it, add this to your shell profile:"
        : "To enable it, remove this from your shell profile:",
    );
    out.push("");
    out.push(options.set === "disable" ? "  export SKILLFUL_TELEMETRY=0" : "  unset SKILLFUL_TELEMETRY");
    out.push("");
    out.push(
      "Skillful does not write to your shell profile itself, so the change is yours to make and yours to see.",
    );
  } else {
    out.push("");
    out.push("  SKILLFUL_TELEMETRY=0 disables logging.");
    out.push("  Nothing is ever sent anywhere: the log is a local file.");
  }

  process.stdout.write(`${out.join("\n")}\n`);
  return 0;
}
