/**
 * dsl/index.ts — Entry point for the complete pgwen DSL.
 *
 * Creates a DslRegistry, registers all built-in step modules, and exports
 * `createDslResolver(scope)` for use by the runner.
 *
 * Usage (in runner / test setup):
 *   import { createDslResolver } from './dsl';
 *   import { Scope } from './engine/Scope';
 *   const scope = new Scope();
 *   const resolver = createDslResolver(scope);
 *   const compositor = new Compositor(registry, scope, interpolator, resolver);
 */

import { DslRegistry } from './registry';
import { registerLocatorBindings } from './bindings/locators';
import { registerTextBindings } from './bindings/text';
import { registerCapture } from './capture/capture';
import { registerPdfCapture } from './capture/pdf';
import { registerNavigation } from './actions/navigation';
import { registerSettings } from './actions/settings';
import { registerElementActions } from './actions/elements';
import { registerDropdownActions } from './actions/dropdowns';
import { registerWaits } from './actions/wait';
import { registerJsActions } from './actions/js';
import { registerWindowActions } from './actions/windows';
import { registerFrameActions } from './actions/frames';
import { registerAlertActions } from './actions/alerts';
import { registerFileActions } from './actions/files';
import { registerProcessActions } from './actions/process';
import { registerJsExecution } from './actions/javascript';
import { registerElementAssertions } from './assertions/elements';
import { registerTextAssertions } from './assertions/text';
import { registerUrlAssertions } from './assertions/url';
import { registerFileAssertions } from './assertions/files';
import { registerDropdownAssertions } from './assertions/dropdowns';
import { registerForEach } from './control/foreach';
import { registerConditions } from './control/conditions';
import { registerMobileDevice } from './mobile/device';
import { registerTouchActions } from './mobile/touch';
import { registerDateTimeFormatter } from './formatting/DateTimeFormatter';
import { registerNumberFormatter } from './formatting/NumberFormatter';
import { registerNetworkInterception } from './playwright/network';
import { registerApiActions } from './playwright/api';
import { registerConsoleCapture } from './playwright/console';
import { registerGeolocation } from './playwright/geolocation';
import { registerClipboard } from './playwright/clipboard';
import { registerPerformance } from './playwright/performance';
import { registerAccessibility } from './playwright/accessibility';
import { registerVisual } from './playwright/visual';
import { registerFileChooser } from './playwright/filechooser';
import { registerHarActions } from './playwright/har';
import { registerVideoActions } from './playwright/video';
import type { Scope } from '../engine/Scope';
import type { DslResolver } from '../engine/Compositor';

// ─── Singleton registry with all built-in steps ──────────────────────────────

const builtinRegistry = new DslRegistry();

registerLocatorBindings(builtinRegistry);
// Settings registers BEFORE text bindings so the specific
// `my <name> setting is "<value>"` form is matched by registerSettings rather
// than being swallowed by the generic `<X> setting is "<value>"` pattern in
// registerTextBindings (which would capture the leading `my ` into the key).
registerSettings(builtinRegistry);
registerTextBindings(builtinRegistry);
// API actions register BEFORE the generic capture/assertion patterns so
// `I capture response value "<jsonPath>" as <name>` / `the response status
// should be ok` / `the response body should …` route to their specific
// handlers rather than getting swallowed by the generic
// `I capture <element> as <name>` and `<ref> should …` patterns.
registerNetworkInterception(builtinRegistry);
registerApiActions(builtinRegistry);
registerCapture(builtinRegistry);
registerPdfCapture(builtinRegistry);
registerNavigation(builtinRegistry);
// Alerts MUST register before element actions: the generic
// `I (type|enter) "<text>" in <element>` pattern would otherwise swallow
// `... in the alert` / `... in the confirmation` and try to resolve them
// as element locator bindings ("No locator binding found for the alert").
registerAlertActions(builtinRegistry);
registerElementActions(builtinRegistry);
registerDropdownActions(builtinRegistry);
registerWaits(builtinRegistry);
registerJsActions(builtinRegistry);
registerWindowActions(builtinRegistry);
registerFrameActions(builtinRegistry);
registerFileActions(builtinRegistry);
registerUrlAssertions(builtinRegistry);
registerTextAssertions(builtinRegistry);
registerElementAssertions(builtinRegistry);
registerFileAssertions(builtinRegistry);
registerDropdownAssertions(builtinRegistry);
registerProcessActions(builtinRegistry);
registerJsExecution(builtinRegistry);
// Control structures (must come after element/text assertions so conditions resolve correctly)
registerForEach(builtinRegistry);
registerConditions(builtinRegistry);
registerMobileDevice(builtinRegistry);
registerTouchActions(builtinRegistry);
registerDateTimeFormatter(builtinRegistry);
registerNumberFormatter(builtinRegistry);
// Playwright-exclusive DSL tier
registerConsoleCapture(builtinRegistry);
registerGeolocation(builtinRegistry);
registerClipboard(builtinRegistry);
registerPerformance(builtinRegistry);
registerAccessibility(builtinRegistry);
registerVisual(builtinRegistry);
registerFileChooser(builtinRegistry);
registerHarActions(builtinRegistry);
registerVideoActions(builtinRegistry);

/**
 * Create a DslResolver bound to the given scope.
 * The resolver is passed to Compositor as the `dslResolver` parameter.
 *
 * `stepDefRunner` lets loop / control-flow handlers (for-each, while,
 * until) execute StepDef substeps. The Compositor wires its
 * StepDef-aware runner through here; without it, the resolver falls
 * back to DSL-only lookup, which breaks the reference-framework pattern
 *   `<stepdef> for each X in Y`.
 */
export function createDslResolver(
  scope: Scope,
  stepDefRunner?: (stepText: string, page: unknown) => Promise<void>,
): DslResolver {
  return builtinRegistry.createResolver(scope, stepDefRunner);
}

/** The built-in registry (for plugins / custom step additions). */
export { builtinRegistry };

// Re-export key types and utilities
export { DslRegistry } from './registry';
export type { HandlerFn, DslEntry } from './registry';
export { buildLocator, resolveLocator, assertText, DslAssertionError, DslStepError } from './locatorUtils';
export type { PageLike, LocatorLike, CompareOp } from './locatorUtils';
export { registerLocatorBindings } from './bindings/locators';
export { registerTextBindings } from './bindings/text';
export { registerCapture } from './capture/capture';
export { registerPdfCapture } from './capture/pdf';
export { registerNavigation } from './actions/navigation';
export { registerSettings } from './actions/settings';
export { registerElementActions } from './actions/elements';
export { registerDropdownActions } from './actions/dropdowns';
export { registerWaits } from './actions/wait';
export { registerJsActions } from './actions/js';
export { registerElementAssertions } from './assertions/elements';
export { registerTextAssertions } from './assertions/text';
export { registerUrlAssertions } from './assertions/url';
export { registerFileAssertions } from './assertions/files';
export { registerWindowActions } from './actions/windows';
export { registerFrameActions } from './actions/frames';
export { registerAlertActions } from './actions/alerts';
export { registerFileActions } from './actions/files';
export { registerForEach } from './control/foreach';
export { registerConditions } from './control/conditions';
export { registerMobileDevice } from './mobile/device';
export { registerTouchActions } from './mobile/touch';
export { registerProcessActions } from './actions/process';
export { registerNetworkInterception } from './playwright/network';
export { registerApiActions } from './playwright/api';
export { registerConsoleCapture } from './playwright/console';
export { registerGeolocation } from './playwright/geolocation';
export { registerClipboard } from './playwright/clipboard';
export { registerPerformance } from './playwright/performance';
export { registerDateTimeFormatter } from './formatting/DateTimeFormatter';
export { registerNumberFormatter } from './formatting/NumberFormatter';
export { registerFileChooser } from './playwright/filechooser';
export { registerHarActions } from './playwright/har';
export { registerVideoActions } from './playwright/video';
export type { StepRunner } from './registry';
export type { BrowserContextLike, RouteLike, ApiRequestContextLike, ApiResponseLike, CdpSessionLike } from './locatorUtils';
