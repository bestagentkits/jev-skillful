/**
 * Redaction for anything that leaves this machine as text a human pastes into an issue.
 *
 * The threat is narrower than it looks and more dangerous than it looks. Skillful's own output
 * is already free of secrets, but an exported case carries prompt text, filesystem paths from the
 * catalog, and whatever the environment happened to contain. A user pasting that into a public
 * issue is the normal use of `skillful export-case`, so redaction has to be the default and has
 * to be tested against the shapes a real machine produces.
 *
 * The rules are deliberately blunt. A path that is not obviously ours still gets its home prefix
 * collapsed, and an environment value is redacted if it looks like a credential by name or by
 * shape, because the cost of over-redacting a reproduction case is a slightly less useful issue
 * and the cost of under-redacting is a leaked key in a public tracker.
 */

/** Environment variable names that are always redacted, matched case-insensitively. */
const SECRET_NAME_PATTERN =
  /(key|token|secret|password|passwd|credential|auth|cookie|session|private|bearer|dsn|connection)/i;

/** Value shapes that are redacted regardless of the variable name. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  // `sk-...`, `ak_live_...`, GitHub tokens, Slack tokens, AWS access keys.
  /\b(sk|rk|pk|ak)[-_][A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Long base64/hex blobs that are almost always a credential rather than content.
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
  /\b[0-9a-f]{32,}\b/gi,
  // JWT.
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

/**
 * Values that look like credentials to a shape rule but are not, and must survive redaction.
 *
 * The catalog fingerprint is a `sha256:<64 hex>` digest of the capability list. It is a
 * deliberately published identity value: it is in every eval report, it is what makes a routing
 * case reproducible, and it reveals nothing that the list of capability *names* does not already
 * reveal. The generic long-hex rule would otherwise destroy it, and a bug report without it cannot
 * be replayed.
 */
const PRESERVE_PATTERNS: readonly RegExp[] = [/sha256:[0-9a-f]{64}/gi];

/** Placeholder used while a preserved value is held aside. Never appears in output. */
const PRESERVE_MARKER = "\u0000skillful-preserved-";

/** Absolute home paths for any user, not just the current one. */
const HOME_PATH_PATTERNS: readonly RegExp[] = [
  /\/Users\/[A-Za-z0-9._-]+/g,
  /\/home\/[A-Za-z0-9._-]+/g,
  /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/g,
];

/** Filesystem paths that are not under a home directory but still identify a machine. */
const ABSOLUTE_PATH_PATTERN =
  /\/(?:private|var|opt|srv|mnt|Volumes|tmp|etc|Applications|Library)\/[^\s"'`)\]}]*/g;

/** Credentials embedded in a URL: `https://user:pass@host`. */
const URL_CREDENTIAL_PATTERN = /(\/\/)[^/\s:@]+(:[^/\s@]*)?@/g;

/** Anything that looks like an email address. */
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export interface RedactOptions {
  /** The current user's home directory, so it can be replaced with `~` rather than `<home>`. */
  homeDir?: string;
  /**
   * Environment values that must never appear in output.
   *
   * Passed in rather than read from `process.env` so the caller controls the snapshot and tests
   * are deterministic.
   */
  env?: Readonly<Record<string, string | undefined>>;
  /** Extra literal strings to redact, for example a base URL the user configured. */
  literals?: readonly string[];
}

/** Collected environment values that must never survive into output. */
function secretEnvValues(options: RedactOptions): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (typeof value !== "string" || value.length < 8) continue;
    if (SECRET_NAME_PATTERN.test(name)) values.push(value);
  }
  return values;
}

/**
 * Redact a string.
 *
 * Order matters: literal secrets are removed first, because a key that happens to look like a
 * base64 blob would otherwise be caught by a generic shape pattern and the more specific
 * replacement would never be reached. Paths come next, so a home directory becomes `~` before the
 * generic absolute-path rule turns the rest of it into `<path>`.
 */
export function redactText(input: string, options: RedactOptions = {}): string {
  let text = input;

  // 0. Hold aside values that a shape rule would wrongly destroy. They are restored at the end,
  //    so the generic rules never see them.
  const preserved: string[] = [];
  for (const pattern of PRESERVE_PATTERNS) {
    text = text.replace(pattern, (match) => {
      preserved.push(match);
      return `${PRESERVE_MARKER}${preserved.length - 1}\u0000`;
    });
  }

  // 1. Exact environment values, before any shape-based rule can reinterpret them.
  for (const value of secretEnvValues(options)) {
    text = text.split(value).join("<redacted-env>");
  }
  for (const literal of options.literals ?? []) {
    if (literal.length >= 4) text = text.split(literal).join("<redacted>");
  }

  // 2. Paths. The home directory collapses to `~`, which is both safe and useful in a bug report.
  if (options.homeDir !== undefined && options.homeDir.length > 1) {
    text = text.split(options.homeDir).join("~");
  }
  for (const pattern of HOME_PATH_PATTERNS) {
    text = text.replace(pattern, "<home>");
  }
  text = text.replace(ABSOLUTE_PATH_PATTERN, "<path>");

  // 3. Credential shapes.
  text = text.replace(URL_CREDENTIAL_PATTERN, "$1<redacted>@");
  for (const pattern of SECRET_VALUE_PATTERNS) {
    text = text.replace(pattern, "<redacted>");
  }
  text = text.replace(EMAIL_PATTERN, "<email>");

  // 4. Restore what was deliberately held aside.
  for (let index = 0; index < preserved.length; index += 1) {
    text = text.split(`${PRESERVE_MARKER}${index}\u0000`).join(preserved[index] ?? "");
  }

  return text;
}

/**
 * Redact every string in a JSON-shaped value, leaving the structure intact.
 *
 * Objects and arrays are rebuilt rather than mutated, so a caller can pass a live structure —
 * for example a `RouteResult` — without the redaction leaking back into it.
 */
export function redactValue<T>(value: T, options: RedactOptions = {}): T {
  if (typeof value === "string") {
    // SAFETY: every branch preserves the shape of `value` and only rewrites the leaves, which are
    // strings. A `T` that is a string, an array of `T`, or a record of `T` therefore maps to a
    // value of the same type. TypeScript cannot express "every leaf is a string", so the
    // recursive structural rewrite needs the assertion to type-check.
    return redactText(value, options) as unknown as T;
  }
  if (Array.isArray(value)) {
    // SAFETY: an array is rebuilt as an array of the same length, in the same order, with each
    // element passed through this same function, so the element type is unchanged.
    return value.map((item) => redactValue(item, options)) as unknown as T;
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = redactValue(item, options);
    }
    // SAFETY: every own enumerable key is copied and each value is rewritten in place, so the
    // result has the same keys and the same value types as the input object.
    return out as unknown as T;
  }
  return value;
}

/** Names of the environment variables that were treated as secret, for the export header. */
export function redactedEnvNames(options: RedactOptions = {}): string[] {
  return Object.entries(options.env ?? {})
    .filter(([name, value]) => typeof value === "string" && value.length >= 8 && SECRET_NAME_PATTERN.test(name))
    .map(([name]) => name)
    .sort();
}
