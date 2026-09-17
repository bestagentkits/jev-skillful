/**
 * Configuration resolution: CLI flag, then environment, then config file, then default.
 *
 * The API key is deliberately outside this system. It is read from the environment by the
 * Jev client and nowhere else, so no configuration file this module reads can ever contain
 * a credential. A config file that tries to set one is rejected loudly rather than
 * silently ignored, because a user who wrote a key into a file needs to know it is both
 * unused and unsafe.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from "../jev/types.js";
import { DEFAULT_QUOTA_GROUPS, type QuotaGroup } from "../retrieval/shortlist.js";
import { DEFAULT_THRESHOLDS, type RouteThresholds } from "../router/thresholds.js";

export interface SkillfulConfig {
  model: string;
  baseUrl: string;
  thresholds: RouteThresholds;
  quotaGroups: readonly QuotaGroup[];
  /** When false, prompt text is not transmitted. */
  uploadPrompt: boolean;
}

export type ConfigSource = "cli" | "env" | "file" | "default";

export interface ResolvedConfig {
  config: SkillfulConfig;
  /** Where each setting's value came from, for `--explain` output. */
  sources: Record<string, ConfigSource>;
  /** Problems found while reading configuration. Non-fatal, reported not thrown. */
  warnings: string[];
  /** Absolute path of the config file consulted, whether or not it existed. */
  configPath: string;
}

/** Keys that must never be read from a config file. */
const FORBIDDEN_FILE_KEYS = ["apiKey", "api_key", "typesafeApiKey", "TYPESAFE_API_KEY", "key", "token"];

/** Environment variable per setting. */
const ENV_KEYS = {
  model: "SKILLFUL_MODEL",
  baseUrl: "SKILLFUL_BASE_URL",
  budgetMs: "SKILLFUL_BUDGET_MS",
  noneThreshold: "SKILLFUL_NONE_THRESHOLD",
  minWinnerProbability: "SKILLFUL_MIN_WINNER_PROBABILITY",
  runnerUpThreshold: "SKILLFUL_RUNNER_UP_THRESHOLD",
  maxRunnersUp: "SKILLFUL_MAX_RUNNERS_UP",
  minPromptChars: "SKILLFUL_MIN_PROMPT_CHARS",
  maxPromptChars: "SKILLFUL_MAX_PROMPT_CHARS",
  requestTimeoutMs: "SKILLFUL_REQUEST_TIMEOUT_MS",
  uploadPrompt: "SKILLFUL_UPLOAD_PROMPT",
} as const;

export function defaultConfigPath(homeDir: string): string {
  return path.join(homeDir, ".config", "skillful", "config.json");
}

export interface ResolveConfigInput {
  /**
   * Highest priority. Comes from parsed CLI flags.
   *
   * `thresholds` is omitted from the partial and re-declared as a partial itself. Without
   * the `Omit`, the intersection with `Partial<RouteThresholds>` collapses back to the
   * full required `RouteThresholds`, because the partial already declares that property.
   */
  cli?: Omit<Partial<SkillfulConfig>, "thresholds"> & { thresholds?: Partial<RouteThresholds> };
  env?: Readonly<Record<string, string | undefined>>;
  homeDir?: string;
  /** Overrides the derived config path. Used by tests. */
  configPath?: string;
  /** Read the config file from memory instead of disk. Used by tests. */
  readFile?: (filePath: string) => string;
}

/** Parse a numeric setting, ignoring values that are not finite numbers. */
function parseNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : undefined;
}

/** Parse a boolean-ish setting. Only explicit spellings are accepted. */
function parseBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  return undefined;
}

/** Shape of the optional config file. Every field is optional. */
interface FileConfig {
  model?: unknown;
  baseUrl?: unknown;
  uploadPrompt?: unknown;
  thresholds?: Record<string, unknown>;
  quotaGroups?: unknown;
}

function parseQuotaGroups(raw: unknown): QuotaGroup[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const groups: QuotaGroup[] = [];

  for (const item of raw) {
    if (typeof item !== "object" || item === null) return undefined;
    const candidate = item as { kinds?: unknown; limit?: unknown };
    if (!Array.isArray(candidate.kinds) || typeof candidate.limit !== "number") return undefined;
    if (candidate.limit < 0) return undefined;

    const kinds = candidate.kinds.filter((kind): kind is string => typeof kind === "string");
    if (kinds.length !== candidate.kinds.length) return undefined;
    groups.push({ kinds: kinds as QuotaGroup["kinds"], limit: candidate.limit });
  }

  return groups.length > 0 ? groups : undefined;
}

/**
 * Resolve the effective configuration.
 *
 * Errors never propagate. A malformed config file produces a warning and the defaults are
 * used, because a hook that refuses to run at all is a worse failure than one running with
 * default thresholds.
 */
export function resolveConfig(input: ResolveConfigInput = {}): ResolvedConfig {
  const env = input.env ?? process.env;
  const homeDir = input.homeDir ?? env["HOME"] ?? ".";
  const configPath = input.configPath ?? defaultConfigPath(homeDir);
  const warnings: string[] = [];
  const sources: Record<string, ConfigSource> = {};

  const readFile = input.readFile ?? ((filePath: string) => readFileSync(filePath, "utf8"));

  let file: FileConfig = {};
  try {
    const parsed: unknown = JSON.parse(readFile(configPath));
    // An array is also `typeof "object"` and non-null, so it has to be excluded
    // explicitly. Without this, `[1,2,3]` is accepted as a config object and every
    // setting silently falls back to its default with no warning.
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      file = parsed as FileConfig;
      for (const forbidden of FORBIDDEN_FILE_KEYS) {
        if (forbidden in file) {
          warnings.push(
            `Ignoring "${forbidden}" in ${configPath}. Credentials are read only from the environment, and a key stored in a file should be treated as leaked.`,
          );
        }
      }
    } else {
      warnings.push(`Ignoring ${configPath}: the top level is not an object`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      warnings.push(`Ignoring unreadable config file ${configPath}`);
    }
  }

  const fileThresholds = (file.thresholds ?? {}) as Record<string, unknown>;
  const cliThresholds: Partial<RouteThresholds> = input.cli?.thresholds ?? {};

  /** Resolve one threshold across the four sources. */
  const threshold = (key: keyof RouteThresholds): number => {
    const fromCli = cliThresholds[key];
    if (typeof fromCli === "number") {
      sources[key] = "cli";
      return fromCli;
    }

    const envKey = ENV_KEYS[key as keyof typeof ENV_KEYS];
    const fromEnv = envKey === undefined ? undefined : parseNumber(env[envKey]);
    if (fromEnv !== undefined) {
      sources[key] = "env";
      return fromEnv;
    }

    const raw = fileThresholds[key];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      sources[key] = "file";
      return raw;
    }

    sources[key] = "default";
    return DEFAULT_THRESHOLDS[key];
  };

  const thresholds: RouteThresholds = {
    noneThreshold: threshold("noneThreshold"),
    minWinnerProbability: threshold("minWinnerProbability"),
    runnerUpThreshold: threshold("runnerUpThreshold"),
    maxRunnersUp: threshold("maxRunnersUp"),
    minPromptChars: threshold("minPromptChars"),
    budgetMs: threshold("budgetMs"),
    maxPromptChars: threshold("maxPromptChars"),
    requestTimeoutMs: threshold("requestTimeoutMs"),
  };

  const model =
    input.cli?.model ??
    env[ENV_KEYS.model]?.trim() ??
    (typeof file.model === "string" ? file.model : undefined) ??
    DEFAULT_MODEL;
  sources["model"] = input.cli?.model !== undefined
    ? "cli"
    : env[ENV_KEYS.model] !== undefined
      ? "env"
      : typeof file.model === "string"
        ? "file"
        : "default";

  const baseUrl =
    input.cli?.baseUrl ??
    env[ENV_KEYS.baseUrl]?.trim() ??
    (typeof file.baseUrl === "string" ? file.baseUrl : undefined) ??
    DEFAULT_BASE_URL;
  sources["baseUrl"] = input.cli?.baseUrl !== undefined
    ? "cli"
    : env[ENV_KEYS.baseUrl] !== undefined
      ? "env"
      : typeof file.baseUrl === "string"
        ? "file"
        : "default";

  const envUpload = parseBoolean(env[ENV_KEYS.uploadPrompt]);
  const uploadPrompt =
    input.cli?.uploadPrompt ??
    envUpload ??
    (typeof file.uploadPrompt === "boolean" ? file.uploadPrompt : undefined) ??
    true;
  sources["uploadPrompt"] = input.cli?.uploadPrompt !== undefined
    ? "cli"
    : envUpload !== undefined
      ? "env"
      : typeof file.uploadPrompt === "boolean"
        ? "file"
        : "default";

  const fileQuotas = parseQuotaGroups(file.quotaGroups);
  if (file.quotaGroups !== undefined && fileQuotas === undefined) {
    warnings.push("Ignoring quotaGroups in the config file: expected an array of {kinds, limit}");
  }
  const quotaGroups = input.cli?.quotaGroups ?? fileQuotas ?? DEFAULT_QUOTA_GROUPS;

  if (thresholds.budgetMs <= 0) {
    warnings.push(`budgetMs must be positive; falling back to ${DEFAULT_THRESHOLDS.budgetMs}`);
    thresholds.budgetMs = DEFAULT_THRESHOLDS.budgetMs;
  }
  if (thresholds.maxRunnersUp < 0) {
    warnings.push("maxRunnersUp must not be negative; falling back to 0");
    thresholds.maxRunnersUp = 0;
  }

  return {
    config: { model, baseUrl, thresholds, quotaGroups, uploadPrompt },
    sources,
    warnings,
    configPath,
  };
}
