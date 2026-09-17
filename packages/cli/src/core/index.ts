/**
 * Public surface of the core package.
 *
 * Everything the CLI and, later, the runtime hooks need is re-exported here so callers
 * never reach into a subdirectory.
 */

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------
export { scanCatalog, findProjectRoot, catalogFingerprint } from "./catalog/scan.js";
export type { ScanOptions } from "./catalog/scan.js";
export { parseFrontmatter } from "./catalog/frontmatter.js";
export { parseMcpServersFromToml } from "./catalog/toml.js";
export { CATALOG_KINDS, CATALOG_RUNTIMES, CATALOG_SCOPES } from "./catalog/types.js";
export type {
  Catalog,
  CatalogEntry,
  CatalogKind,
  CatalogRuntime,
  CatalogScope,
  CatalogSource,
  ScanContext,
} from "./catalog/types.js";
export { normaliseDescription, normaliseName, catalogId } from "./catalog/types.js";

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------
export { tokenize } from "./retrieval/tokenize.js";
export { rankBm25 } from "./retrieval/bm25.js";
export type { Bm25Doc, Bm25Options, ScoredDoc } from "./retrieval/bm25.js";
export {
  buildShortlist,
  DEFAULT_QUOTA_GROUPS,
  DEFAULT_SHORTLIST_SIZE,
} from "./retrieval/shortlist.js";
export type {
  QuotaGroup,
  Shortlist,
  ShortlistEntry,
  ShortlistGroupResult,
  ShortlistOptions,
} from "./retrieval/shortlist.js";

// ---------------------------------------------------------------------------
// Jev client
// ---------------------------------------------------------------------------
export { callSystemOne, JevError, resolveApiKey } from "./jev/client.js";
export type { JevClientOptions, JevErrorCode } from "./jev/client.js";
export { API_KEY_ENV, DEFAULT_BASE_URL, DEFAULT_MODEL } from "./jev/types.js";
export type {
  Answer,
  ChoiceAnswer,
  ChoiceQuestion,
  NoulAnswer,
  NoulQuestion,
  Question,
  SystemOneRequest,
  SystemOneResponse,
} from "./jev/types.js";
export { isChoiceAnswer, isNoulAnswer } from "./jev/types.js";

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export { route } from "./router/route.js";
export type {
  DegradedReason,
  RouteDecision,
  RouteOptions,
  RoutePick,
  RouteRankedPick,
  RouteResult,
  SkipReason,
} from "./router/route.js";
export {
  DEFAULT_THRESHOLDS,
  evaluatePromptHeuristics,
  truncatePrompt,
} from "./router/thresholds.js";
export type {
  PromptHeuristicResult,
  RouteThresholds,
  SkipReason as PromptSkipReason,
} from "./router/thresholds.js";
export {
  buildRouteRequest,
  buildRouteState,
  NONE_OPTION,
  PRIMARY_QUESTION_ID,
  toCandidate,
} from "./router/questions.js";
export type { BuiltRequest, Candidate, RouteState } from "./router/questions.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export { defaultConfigPath, resolveConfig } from "./config/resolve.js";
export type { ConfigSource, ResolvedConfig, ResolveConfigInput, SkillfulConfig } from "./config/resolve.js";
