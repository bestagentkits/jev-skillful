/**
 * HTTP client for the TypeSafe System One endpoint.
 *
 * Two rules shape this file. The API key never appears in an error message, a log line,
 * or a returned value — it is attached to exactly one request header and referenced
 * nowhere else. And nothing throws past this boundary: every failure is converted into a
 * typed error whose `code` the router maps onto a degraded routing result.
 */

import {
  API_KEY_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  type SystemOneRequest,
  type SystemOneResponse,
} from "./types.js";

/** Failure modes the router can act on. Each maps to a `degraded` reason. */
export type JevErrorCode = "auth" | "upstream" | "network" | "timeout" | "malformed" | "config";

export class JevError extends Error {
  readonly code: JevErrorCode;
  readonly status?: number;

  constructor(code: JevErrorCode, message: string, status?: number) {
    super(message);
    this.name = "JevError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export interface JevClientOptions {
  /** Overrides the `TYPESAFE_API_KEY` environment variable. For tests and embedding. */
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Timeout for a single HTTP attempt, not for the whole retry sequence. */
  requestTimeoutMs?: number;
  /** Retries after the first attempt. Applied to 429 and 529 only. */
  maxRetries?: number;
  /** Backoff before the first retry, doubled each time. */
  retryBaseDelayMs?: number;
  /** Injected so tests never touch the network. */
  fetchImpl?: typeof fetch;
  /** Injected so tests do not wait for real backoff. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Environment snapshot. Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * Caller-owned deadline signal, aborted when the overall routing budget expires.
   *
   * The per-attempt timeout bounds one HTTP attempt; this bounds the entire retry
   * sequence, so a budget can be enforced rather than merely approximated.
   */
  signal?: AbortSignal;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 1800;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;

/** Statuses worth retrying: rate limit and upstream overload. 401 and 422 are not. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 529]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Read the abort state through a call rather than a property access.
 *
 * Control-flow analysis narrows `signal.aborted` to `false` after the first guard, and
 * that narrowing survives into later iterations of the retry loop, which makes the second
 * check look unreachable. A call boundary keeps the check honest.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/** Resolve the API key from options then environment. Blank values count as absent. */
export function resolveApiKey(options: JevClientOptions = {}): string | undefined {
  const fromOption = options.apiKey?.trim();
  if (fromOption !== undefined && fromOption.length > 0) return fromOption;

  const env = options.env ?? process.env;
  const fromEnv = env[API_KEY_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;

  return undefined;
}

/**
 * Convert a fetch rejection into a typed error.
 *
 * An aborted request and a timeout are the same thing here, and both are separated from
 * a genuine network failure because the router reports them differently.
 */
function classifyFetchFailure(error: unknown, timedOut: boolean): JevError {
  if (timedOut) {
    return new JevError("timeout", "TypeSafe request exceeded its timeout");
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new JevError("timeout", "TypeSafe request was aborted");
  }
  // The message is built from the error name only. A thrown fetch error can carry the
  // request URL, and that URL is safe, but it must never be joined with a key or a body.
  const reason = error instanceof Error ? error.name : "unknown";
  return new JevError("network", `TypeSafe request failed before a response (${reason})`);
}

/**
 * POST a question set and return the answers.
 *
 * Retries `maxRetries` times on 429 and 529 with exponential backoff. A 401 is returned
 * immediately as an `auth` error because retrying an invalid key cannot succeed and would
 * burn the caller's timeout budget.
 */
export async function callSystemOne(
  request: SystemOneRequest,
  options: JevClientOptions = {},
): Promise<SystemOneResponse> {
  const apiKey = resolveApiKey(options);
  if (apiKey === undefined) {
    throw new JevError("config", `Missing API key. Set ${API_KEY_ENV} in the environment.`);
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new JevError("config", "No fetch implementation available in this runtime");
  }

  const sleep = options.sleepImpl ?? defaultSleep;
  const url = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;

  const body = JSON.stringify({ ...request, model: request.model || DEFAULT_MODEL });

  const externalSignal = options.signal;
  let lastError: JevError | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    // A budget that expired before this attempt cannot be waited out; fail immediately so
    // the router can report a timeout instead of overrunning its ceiling.
    if (isAborted(externalSignal)) {
      throw new JevError("timeout", "Routing budget expired before the request was sent");
    }

    const controller = new AbortController();
    const onExternalAbort = (): void => {
      controller.abort();
    };
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    let timedOut = false;

    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = httpError(response.status);
        if (!RETRYABLE_STATUSES.has(response.status) || attempt === maxRetries) {
          throw error;
        }
        lastError = error;
      } else {
        return await parseResponse(response);
      }
    } catch (error) {
      if (error instanceof JevError) {
        if (!RETRYABLE_STATUSES.has(error.status ?? 0) || attempt === maxRetries) throw error;
        lastError = error;
      } else {
        const classified = classifyFetchFailure(error, timedOut);
        // A timeout is retried as well: the request may have failed before leaving, and
        // the caller has already bounded the whole routing budget.
        if (attempt === maxRetries) throw classified;
        lastError = classified;
      }
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
      timedOut = false;
    }

    // An expired external budget must not be retried, even if the failure looked
    // retryable, because there is no budget left to spend.
    if (isAborted(externalSignal)) {
      throw new JevError("timeout", "Routing budget expired during the request");
    }

    if (attempt < maxRetries) {
      await sleep(baseDelay * 2 ** attempt);
    }
  }

  throw lastError ?? new JevError("upstream", "TypeSafe request failed for an unknown reason");
}

/** Map a non-2xx status onto a typed error. The body is never echoed, only the status. */
function httpError(status: number): JevError {
  if (status === 401 || status === 403) {
    return new JevError("auth", `TypeSafe rejected the API key (HTTP ${status})`, status);
  }
  if (status === 422) {
    return new JevError("upstream", "TypeSafe rejected the request as invalid (HTTP 422)", status);
  }
  return new JevError("upstream", `TypeSafe returned HTTP ${status}`, status);
}

/** Parse and shape-check a successful response. */
async function parseResponse(response: Response): Promise<SystemOneResponse> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new JevError("malformed", "TypeSafe returned a body that is not JSON");
  }

  if (typeof payload !== "object" || payload === null) {
    throw new JevError("malformed", "TypeSafe returned a non-object body");
  }

  const candidate = payload as Partial<SystemOneResponse>;
  if (typeof candidate.answers !== "object" || candidate.answers === null) {
    throw new JevError("malformed", "TypeSafe response has no answers map");
  }

  return {
    model: typeof candidate.model === "string" ? candidate.model : DEFAULT_MODEL,
    answers: candidate.answers,
    ...(candidate.usage === undefined ? {} : { usage: candidate.usage }),
  };
}
