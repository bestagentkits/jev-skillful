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
// Eval
// ---------------------------------------------------------------------------
export {
  ABSTAIN,
  FIXTURE_GROUPS,
  FixtureError,
  buildGoldIndex,
  groupCounts,
  parseFixtures,
  resolveFixtures,
} from "./eval/fixtures.js";
export type { Fixture, FixtureGroup, ResolvedFixture } from "./eval/fixtures.js";
export {
  hasInfrastructureIdentifier,
  isPublicSafe,
  loadCorpus,
  redactInfrastructure,
  sanitiseCorpus,
  saveCorpus,
  PRIVATE_MARKERS,
} from "./eval/corpus.js";
export type { CorpusSnapshot } from "./eval/corpus.js";
export { abstained, chosenId, decisionMetrics, decisionMetricsByGroup, decisionSignature } from "./eval/metrics/decision.js";
export type { DecisionMetrics } from "./eval/metrics/decision.js";
export { latencyMetrics, percentile } from "./eval/metrics/latency.js";
export type { LatencyMetrics } from "./eval/metrics/latency.js";
export { retrievalMetrics, retrievalMetricsByKind } from "./eval/metrics/retrieval.js";
export type { FixtureOutcome, KindRetrieval, RetrievalMetrics } from "./eval/metrics/retrieval.js";
export { stabilityMetrics } from "./eval/metrics/stability.js";
export type { FixtureStability, StabilityMetrics } from "./eval/metrics/stability.js";
export { fixtureGroupsOf, runEval } from "./eval/run.js";
export type { EvalConfig, EvalOptions, EvalReport, RouteCaller } from "./eval/run.js";
export { DEFAULT_GATE, evaluateGate, renderGateText, renderMarkdown } from "./eval/report.js";
export type { GateCheck, GateCriteria, GateResult, ReportProvenance } from "./eval/report.js";
export { DEFAULT_SWEEP_GRID, quotaGroupsWithSkillLimit, renderSweep, runSweep } from "./eval/sweep.js";
export type { SweepGrid, SweepOptions, SweepPoint } from "./eval/sweep.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export { defaultConfigPath, resolveConfig } from "./config/resolve.js";
export type { ConfigSource, ResolvedConfig, ResolveConfigInput, SkillfulConfig } from "./config/resolve.js";

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------
export { detectRuntimes, presentRuntimes, runtimeLocations } from "./hooks/detect.js";
export type { DetectedRuntime, RuntimeLocation } from "./hooks/detect.js";
export {
  backupFile,
  ensureDir,
  isSkillfulCommand,
  isSkillfulEntry,
  readJsonFile,
  removeSkillfulEntries,
  SKILLFUL_HOOK_MARKER,
  upsertSkillfulEntry,
  writeJsonAtomic,
} from "./hooks/json-merge.js";
export type { HookCommand, HookEntry, JsonReadResult } from "./hooks/json-merge.js";
export {
  cacheGet,
  cacheSet,
  CACHE_VERSION,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TTL_MS,
  emptyCache,
  loadCache,
  normalisePrompt,
  pruneCache,
  routeCacheKey,
  saveCache,
} from "./hooks/cache.js";
export type { CacheStore, CachedRoute } from "./hooks/cache.js";
export { DEGRADED_REMINDER, degradedReminder, describeDegraded, isBenignSkip } from "./hooks/degrade.js";
export { DEFAULT_MAX_CHARS, DEFAULT_MAX_RUNNERS_UP, INJECTION_PREFIX, renderInjection } from "./hooks/render.js";
export type { RenderOptions } from "./hooks/render.js";
export { DISABLE_ENV, injectionPayload, isDisabled, runHook } from "./hooks/runner.js";
export type { HookDeps, HookInput, HookOutcome, HookPayload } from "./hooks/runner.js";
export {
  buildInstallContext,
  hookStatus,
  installHooks,
  uninstallHooks,
} from "./hooks/install.js";
export type { HookStatus, InstallSummary, UninstallSummary } from "./hooks/install.js";
export { installClaudeCode, uninstallClaudeCode } from "./hooks/installers/claude-code.js";
export { installCodex, uninstallCodex } from "./hooks/installers/codex.js";
export { installPi, uninstallPi } from "./hooks/installers/pi.js";
export { installOmp, uninstallOmp } from "./hooks/installers/omp.js";
export { extensionSource } from "./hooks/installers/extension-source.js";
export type { InstallContext, InstallOutcome, UninstallOutcome } from "./hooks/installers/types.js";

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------
export {
  isTelemetryDisabled,
  TELEMETRY_DISABLE_ENV,
  buildCapabilityUsedEvent,
  buildRouteEvent,
  logSize,
  writeEvent,
} from "./telemetry/writer.js";
export type { WriteOptions } from "./telemetry/writer.js";
export {
  MAX_CANDIDATE_IDS,
  MAX_LINE_BYTES,
  MAX_RANKING_ENTRIES,
  ROUTE_DECISIONS,
  SCHEMA_VERSION,
  USAGE_SOURCES,
  isTelemetryEvent,
} from "./telemetry/events.js";
export type {
  CapabilityUsedEvent,
  RankingEntry,
  RouteEvent,
  TelemetryEvent,
  UsageSource,
} from "./telemetry/events.js";
export { readEvents, routeEvents, usageEvents } from "./telemetry/reader.js";
export type { ReadOptions, ReadResult } from "./telemetry/reader.js";
export {
  APP_DIR_NAME,
  EVENTS_FILE_NAME,
  defaultReportPath,
  eventsPath,
  rotatedEventsPath,
  stateDir,
} from "./telemetry/paths.js";
export type { PathContext } from "./telemetry/paths.js";
export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ROTATED,
  DEFAULT_RETENTION_DAYS,
  MAINTENANCE_INTERVAL,
  maintain,
  rotatedPaths,
} from "./telemetry/retention.js";
export type { RetentionOptions, RetentionResult } from "./telemetry/retention.js";
export { ACCEPTANCE_WINDOW_MS, matchUsage, summarise } from "./telemetry/aggregate.js";
export type {
  AdoptionStats,
  CandidateStat,
  OperationalStats,
  OverviewStats,
  TelemetrySummary,
} from "./telemetry/aggregate.js";
export {
  barChart,
  confusionTable,
  escapeHtml,
  formatNumber,
  formatRate,
  histogram,
  latencyBuckets,
} from "./telemetry/charts.js";
export { loadBenchOutcome, redactReport, renderDashboard } from "./telemetry/dashboard.js";
export type { BenchOutcome, DashboardInput } from "./telemetry/dashboard.js";

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------
export { redactText, redactValue, redactedEnvNames } from "./redact.js";
export type { RedactOptions } from "./redact.js";
