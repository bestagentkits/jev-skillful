/**
 * `skillful export-case` — turn a routing decision into something safe to paste in an issue.
 *
 * The point is to make the honest thing the easy thing. A user who just saw a bad routing
 * decision has two options: describe it vaguely in prose, or paste the raw internals. The first
 * is useless and the second leaks paths and possibly a key. This command produces a third: the
 * full decision, the shortlist, the scores and the thresholds, with every machine-specific and
 * credential-shaped value removed before anything is written.
 *
 * It reads from the route cache, so a case can be exported for a prompt that was already routed
 * without paying for a second round trip. With `--prompt` it routes a fresh prompt instead.
 */

import { createHash } from "node:crypto";
import { resolveConfig } from "../core/config/resolve.js";
import { scanCatalog } from "../core/catalog/scan.js";
import { loadCache, normalisePrompt, routeCacheKey } from "../core/hooks/cache.js";
import { defaultCachePath } from "../core/hooks/runner.js";
import { route, type RouteResult } from "../core/router/route.js";
import { redactText, redactValue, redactedEnvNames } from "../core/redact.js";

export interface ExportCaseOptions {
  /** A prompt to route fresh. Mutually exclusive with `hash`. */
  prompt?: string;
  /** A prompt hash, as printed by `doctor` or the cache. */
  hash?: string;
  homeDir?: string;
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  json?: boolean;
}

/** The stable hash a prompt is identified by. Matches the cache key's prompt component. */
export function promptHash(prompt: string): string {
  return createHash("sha256").update(normalisePrompt(prompt)).digest("hex").slice(0, 16);
}

export async function exportCaseCommand(options: ExportCaseOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env["HOME"] ?? ".";
  const cwd = options.cwd ?? process.cwd();
  const redactOptions = { homeDir, env };

  if (options.prompt === undefined && options.hash === undefined) {
    process.stderr.write(
      "export-case needs --prompt <text> to route a fresh prompt, or --hash <hash> to export a cached case.\n",
    );
    return 1;
  }
  if (options.prompt !== undefined && options.hash !== undefined) {
    process.stderr.write("export-case takes either --prompt or --hash, not both.\n");
    return 1;
  }

  const resolved = resolveConfig({ env, homeDir });
  const prompt = options.prompt;
  let result: RouteResult;
  let catalogFingerprint: string;
  let shortlistDetail: unknown = [];
  let shortlist: readonly string[] = [];

  const scanned = await scanCatalog({ homeDir, cwd, env });
  catalogFingerprint = scanned.fingerprint;

  if (prompt !== undefined) {
    result = await route(prompt, {
      entries: scanned.entries,
      thresholds: resolved.config.thresholds,
      quotaGroups: resolved.config.quotaGroups,
      model: resolved.config.model,
      baseUrl: resolved.config.baseUrl,
      uploadPrompt: resolved.config.uploadPrompt,
    });
    shortlist = result.shortlist;
    shortlistDetail = result.shortlistDetail;
  } else {
    // A hash identifies a prompt, but the prompt text itself is never stored in the cache. So a
    // cached case can be exported only if the caller also supplies the prompt; a bare hash is
    // enough to locate the entry but not to reproduce it.
    const store = loadCache(defaultCachePath(homeDir));
    const hash = options.hash ?? "";
    const match = Object.entries(store.entries).find(([key]) => key.startsWith(hash));
    if (match === undefined) {
      process.stderr.write(
        `No cached case matches ${hash}.\nPrompt text is not stored in the cache, so pass --prompt to export the decision directly.\n`,
      );
      return 1;
    }
    result = match[1].result;
    shortlist = result.shortlist;
    shortlistDetail = result.shortlistDetail;
  }

  // The prompt itself is the one thing a user may not want to publish, so it is redacted like
  // everything else and truncated: a reproduction needs enough to retrieve, not the whole message.
  const exportedPrompt = redactText(prompt ?? "(not supplied; decision read from cache)", redactOptions);
  const truncatedPrompt = exportedPrompt.length > 400 ? `${exportedPrompt.slice(0, 400)}…` : exportedPrompt;

  const exported = {
    skillful: { version: "0.1.0" },
    generatedAt: new Date().toISOString(),
    machine: {
      // Enough to reproduce the retrieval, and nothing that identifies the machine.
      node: process.version,
      platform: process.platform,
      catalogEntries: scanned.entries.length,
      catalogFingerprint,
      redactedEnv: redactedEnvNames(redactOptions),
    },
    prompt: { hash: promptHash(prompt ?? shortlist.join("|")), text: truncatedPrompt },
    thresholds: resolved.config.thresholds,
    decision: result.decision,
    shortlist,
    shortlistDetail,
    latencyMs: result.latencyMs,
    promptChars: result.promptChars,
    model: result.model,
  };

  // A final pass over the whole structure. The individual fields above are already redacted, but
  // the catalog-derived parts (picked capability paths, shortlist ids) are not, and this is the
  // guarantee that nothing escapes: whatever the shape of the data, every string goes through it.
  const safe = redactValue(exported, redactOptions);

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`${renderCaseMarkdown(safe, redactedEnvNames(redactOptions))}\n`);
  return 0;
}

/** Markdown block, ready to paste into the `bad-route` issue template. */
export function renderCaseMarkdown(safe: Record<string, unknown>, redactedEnv: readonly string[]): string {
  const lines: string[] = [];
  const decision = safe["decision"] as { kind?: string } | undefined;
  const machine = safe["machine"] as Record<string, unknown> | undefined;
  const prompt = safe["prompt"] as Record<string, unknown> | undefined;

  // Truncated for readability, never after redaction: slicing a `<redacted>` marker produced a
  // truncated, unbalanced marker in an earlier version, which read as corruption in a bug report.
  const fingerprint = String(machine?.["catalogFingerprint"] ?? "?");
  const shortFingerprint =
    fingerprint.length > 20 ? `${fingerprint.slice(0, 20)}…` : fingerprint;

  lines.push("### Skillful routing case");
  lines.push("");
  lines.push("```yaml");
  lines.push(`decision: ${decision?.kind ?? "unknown"}`);
  lines.push(`catalogEntries: ${String(machine?.["catalogEntries"] ?? "?")}`);
  lines.push(`catalogFingerprint: ${shortFingerprint}`);
  lines.push(`promptHash: ${String(prompt?.["hash"] ?? "?")}`);
  lines.push(`latencyMs: ${String(safe["latencyMs"] ?? "?")}`);
  lines.push(`model: ${String(safe["model"] ?? "?")}`);
  lines.push("```");
  lines.push("");
  if (redactedEnv.length > 0) {
    lines.push(
      `Redacted before export: ${redactedEnv.join(", ")}, plus every filesystem path and credential-shaped value.`,
    );
    lines.push("");
  }
  lines.push("Prompt as routed (truncated, redacted):");
  lines.push("");
  lines.push("```text");
  lines.push(String(prompt?.["text"] ?? ""));
  lines.push("```");
  lines.push("");
  lines.push("Full decision:");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(safe, null, 2));
  lines.push("```");

  return lines.join("\n");
}
