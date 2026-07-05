/**
 * @pgwen/core — Public API
 *
 * This is the entry point for project repos that consume pgwen as a dependency.
 *
 * Project repo usage:
 *   import { registerStep, createDslResolver, Scope } from '@pgwen/core';
 *
 * Three extension categories are exported:
 *
 *   1. DSL authoring — register custom step primitives
 *   2. Engine types  — Scope, RunResult, etc. for custom integrations
 *   3. Runner API    — run features programmatically from Node.js scripts
 */

// ─── DSL Extension API ────────────────────────────────────────────────────────

export { builtinRegistry, createDslResolver } from './dsl/index';
export { DslRegistry } from './dsl/registry';
export type { DslEntry, HandlerFn } from './dsl/registry';

// ─── Engine ───────────────────────────────────────────────────────────────────

export { Scope } from './engine/Scope';
export type { ScopeLayerName, LazyResolver, LocatorFn } from './engine/Scope';

export { StringInterpolator } from './engine/StringInterpolator';

export { GherkinParser } from './engine/GherkinParser';
export type {
  ParsedFeature,
  ParsedScenario,
  ParsedStep,
  ParsedBackground,
  ParsedExamples,
} from './engine/GherkinParser';

export { MetaEngine, MetaCyclicImportError, IllegalStepAnnotationException, AmbiguousCaseException, type LoadedMetaFile } from './engine/MetaEngine';

export {
  StepDefRegistry,
  buildStepDef,
  resolveEffectiveKeyword,
  resolveEffectiveKeywords,
  BehaviourRuleError,
  UndefinedStepError,
} from './engine/StepDefRegistry';
export type { StepDef, ResolvedStep, BehaviourMode } from './engine/StepDefRegistry';

export { Compositor, CompositorError } from './engine/Compositor';
export type {
  StepResult,
  StepStatus,
  DslHandler,
  DslResolver,
  CompositorOptions,
} from './engine/Compositor';

export { parseAnnotations, hasAnnotation } from './annotations/Annotations';
export type { ParsedAnnotations, ExamplesAnnotation } from './annotations/Annotations';

export { loadLayered, loadLayeredWithMasked, loadFile, parseHoconSource } from './engine/ProfileLoader';
export type { Config, LoadResult } from './engine/ProfileLoader';

export {
  resolveBrowserConfig,
  DEFAULT_BROWSER_CONFIG,
} from './engine/BrowserConfig';
export type {
  BrowserConfig,
  BrowserType,
  VideoMode,
  TraceMode,
} from './engine/BrowserConfig';

export { ImplicitValues } from './engine/ImplicitValues';

// ─── Execution ────────────────────────────────────────────────────────────────

export { Runner } from './execution/Runner';
export type {
  RunOptions,
  RunResult,
  ScenarioRunResult,
} from './execution/Runner';

export { ParallelRunner } from './execution/ParallelRunner';
export type {
  ParallelRunOptions,
  ParallelRunResult,
} from './execution/ParallelRunner';

export { PlaywrightRunner } from './execution/PlaywrightRunner';
export type { PlaywrightRunnerOptions } from './execution/PlaywrightRunner';

export { DryRunner } from './execution/DryRunner';

export { TagFilter } from './execution/TagFilter';

export { SyncGate } from './execution/SyncGate';

// ─── Data layer ───────────────────────────────────────────────────────────────

export {
  parseCsvFeed,
  parseCsvContent,
  bindRecordToScope,
  getFeedHeaders,
} from './data/CsvFeedReader';
export type { DataRecord } from './data/CsvFeedReader';

export { parseJsonFeed, bindJsonRecordToScope } from './data/JsonFeedReader';

export {
  initResultsFile,
  appendResultRow,
  buildResultRowFromScope,
  csvEscapePgwen,
} from './data/ResultsWriter';
export type { ResultRow } from './data/ResultsWriter';

// ─── Reporting ────────────────────────────────────────────────────────────────

export { HtmlReporter, toFeatureTrace } from './reporting/HtmlReporter';
export { JUnitReporter } from './reporting/JUnitReporter';
export { JsonReporter } from './reporting/JsonReporter';
export type {
  JsonReport,
  JsonFeature,
  JsonScenario,
  JsonStep,
  JsonSummary,
  JsonStatusCounts,
  JsonReportOptions,
} from './reporting/JsonReporter';
export { ConsoleReporter } from './reporting/ConsoleReporter';
export type { ConsoleReporterOptions } from './reporting/ConsoleReporter';
export { ScreenshotCapture } from './reporting/ScreenshotCapture';
export type { ScreenshotPage } from './reporting/ScreenshotCapture';

// ─── Fix — AI-proposed locator fixes (folded from former @pgwen/fix package) ──

export { runSuggestFix, resolveConfig } from './fix/Suggest';
export { buildUnifiedDiff } from './fix/PatchApplier';
export { validateSuggestion } from './fix/MinimumDiffValidator';
export {
  appendHistory,
  readHistory,
  countPriorAttempts,
  isRepeatFix,
  buildHistoryKey,
} from './fix/RepeatFixDetector';
export {
  writeSuggestion,
  readSuggestions,
  slugify,
  buildSuggestionId,
} from './fix/SuggestionWriter';
