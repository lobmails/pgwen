/**
 * actions/settings.ts — Runtime browser settings steps.
 *
 * Implements the DSL patterns for mutating browser-level settings at runtime.
 * These mirror `my <name> setting is "<value>"` / `I reset my <name> setting`.
 *
 *   my pgwen.web.useragent setting is "<value>"   ← specific: sets User-Agent header
 *   I reset my pgwen.web.useragent setting        ← specific: clears User-Agent header
 *   my <name> property/setting is "<value>"      ← generic: stores in scope
 *   I reset my <name> property/setting           ← generic: clears scope value
 */

import type { DslRegistry } from '../registry';
import type { PageLike } from '../locatorUtils';

export function registerSettings(registry: DslRegistry): void {

  // my [pgwen|pgwen].web.useragent setting is "<value>"
  // Sets the User-Agent header for all subsequent navigation requests from this page.
  // Must be registered BEFORE the generic form so it takes precedence.
  // Accepts both `pgwen.web.useragent` (pgwen) and `pgwen.web.useragent` (projects).
  registry.register(
    /^my (?:pgwen|pgwen)\.web\.useragent (?:setting|property) is "(.+)"$/i,
    async ([value], scope, page) => {
      await (page as PageLike).setExtraHTTPHeaders({ 'User-Agent': value! });
      scope.set('pgwen.web.useragent', value!);
    }
  );

  // I reset my [pgwen|pgwen].web.useragent setting
  // Clears the User-Agent override, restoring browser default behaviour.
  registry.register(
    /^I reset my (?:pgwen|pgwen)\.web\.useragent (?:setting|property)$/i,
    async (_, scope, page) => {
      await (page as PageLike).setExtraHTTPHeaders({});
      scope.set('pgwen.web.useragent', '');
    }
  );

  // my <name> property/setting is "<value>"  — generic form
  // Stores the value in scope under the given key, transparent so it persists
  // out of StepDef scope (matches the bare `<X> setting is "Y"` form). Used by
  // projects to set runtime config values such as `my pgwen.web.sendKeys.clearFirst
  // setting is "true"` inside a StepDef body and read it later in the outer
  // scenario.
  registry.register(
    /^my (.+?) (?:setting|property) is "([^"]*)"$/i,
    async ([name, value], scope) => {
      scope.setTransparent(name!.trim(), value!);
    }
  );

  // I reset my <name> property/setting  — generic reset form
  // Clears the scope binding for the given key (transparent, persists out of
  // StepDef scope).
  registry.register(
    /^I reset my (.+?) (?:setting|property)$/i,
    async ([name], scope) => {
      scope.setTransparent(name!.trim(), '');
    }
  );
}
