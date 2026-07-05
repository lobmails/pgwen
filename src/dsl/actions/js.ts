/**
 * actions/js.ts — JavaScript execution steps.
 *
 *   I execute the javascript "<script>"
 *   I execute the javascript "<script>" and capture the result as <name>
 *   I execute the javascript file "<filepath>"
 *   I execute the javascript file "<filepath>" and capture the result as <name>
 */

import * as fs from 'fs';
import type { DslRegistry } from '../registry';
import type { PageLike } from '../locatorUtils';

export function registerJsActions(registry: DslRegistry): void {

  // I execute the javascript "<script>" and capture the result as <name>
  registry.register(
    /^I execute the (?:javascript|js) "(.+)" and capture the result as (.+)$/i,
    async ([script, name], scope, page) => {
      const result = await (page as PageLike).evaluate(script!);
      scope.set(name!.trim(), result == null ? '' : String(result));
    }
  );

  // I execute the javascript "<script>"
  registry.register(
    /^I execute the (?:javascript|js) "(.+)"$/i,
    async ([script], _scope, page) => {
      await (page as PageLike).evaluate(script!);
    }
  );

  // I execute the javascript file "<filepath>" and capture the result as <name>
  registry.register(
    /^I execute the (?:javascript|js) file "([^"]+)" and capture the result as (.+)$/i,
    async ([filepath, name], scope, page) => {
      const script = fs.readFileSync(filepath!, 'utf-8');
      const result = await (page as PageLike).evaluate(script);
      scope.set(name!.trim(), result == null ? '' : String(result));
    }
  );

  // I execute the javascript file "<filepath>"
  registry.register(
    /^I execute the (?:javascript|js) file "([^"]+)"$/i,
    async ([filepath], _scope, page) => {
      const script = fs.readFileSync(filepath!, 'utf-8');
      await (page as PageLike).evaluate(script);
    }
  );
}
