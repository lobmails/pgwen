/**
 * actions/elements.ts — Element interaction steps.
 *
 * Implements complete element action DSL:
 *   I click <element>
 *   I right click <element>
 *   I double click <element>
 *   I click <element> of <context>
 *   I check / I tick <checkbox>
 *   I uncheck / I untick <checkbox>
 *   I move to <element>
 *   I type "<text>" in <element>
 *   I enter "<text>" in <element>   (type + Enter)
 *   I type <ref> in <element>
 *   I enter <ref> in <element>
 *   I append "<text>" to <element>
 *   I append <ref> to <element>
 *   I press enter in <element>
 *   I press tab in <element>
 *   I send "<keys>" to <element>
 *   I clear <element>
 *   I highlight <element>  — applies pgwen.web.highlight.style CSS for pgwen.web.throttle.msecs
 *   I locate <element>     — resolves element (validates it can be found)
 *   I scroll to <element>
 *   I scroll to the top of <element>
 *   I scroll to the bottom of <element>
 *   I scroll to the top of the page
 *   I scroll to the bottom of the page
 *   I drag <source> to <target>
 *   I upload the file "<filepath>" to <element>
 */

import type { DslRegistry } from '../registry';
import { resolveLocator, type PageLike } from '../locatorUtils';

export function registerElementActions(registry: DslRegistry): void {
  const reg = registry.withCategory('locator-action');

  // ─── Click ──────────────────────────────────────────────────────────────────

  // I click <element>
  reg.register(
    /^I click (.+)$/i,
    async ([elementName], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      await loc.click();
    }
  );

  // I right click <element>
  reg.register(
    /^I right click (.+)$/i,
    async ([elementName], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      await loc.click({ button: 'right' });
    }
  );

  // I double click <element>
  reg.register(
    /^I double click (.+)$/i,
    async ([elementName], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      await loc.dblclick();
    }
  );

  // I click <element> of <context>   [context narrows scope for disambiguation]
  reg.register(
    /^I click (.+) of (.+)$/i,
    async ([elementName, _contextName], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      await loc.click();
    }
  );

  // I right click <element> of <context>
  reg.register(
    /^I right click (.+) of (.+)$/i,
    async ([elementName, _contextName], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      await loc.click({ button: 'right' });
    }
  );

  // I double click <element> of <context>
  reg.register(
    /^I double click (.+) of (.+)$/i,
    async ([elementName, _contextName], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      await loc.dblclick();
    }
  );

  // ─── Modifier-key click ─────────────────────────────────────────────────────

  // I <modifier>+... click <element>   e.g. "SHIFT click", "COMMAND+SHIFT click"
  reg.register(
    /^I ((?:[A-Z]+\+)*[A-Z]+) click (.+)$/,
    async ([modifiers, elementName], scope) => {
      const playwrightModifiers = modifiers!.split('+').map(normaliseModifier).filter(Boolean);
      const loc = await resolveLocator(elementName!.trim(), scope);
      await loc.click({ modifiers: playwrightModifiers });
    }
  );

  // ─── Check / Tick ────────────────────────────────────────────────────────────

  // I check <element> / I tick <element>
  reg.register(
    /^I (?:check|tick) (.+)$/i,
    async ([elementName], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      await loc.check();
    }
  );

  // I uncheck <element> / I untick <element>
  reg.register(
    /^I (?:uncheck|untick) (.+)$/i,
    async ([elementName], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      await loc.uncheck();
    }
  );

  // ─── Hover / Move to ────────────────────────────────────────────────────────

  // I move to <element>
  reg.register(
    /^I move to (.+)$/i,
    async ([elementName], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      await loc.hover();
    }
  );

  // ─── Type / Enter ────────────────────────────────────────────────────────────

  // I type "<text>" in <element>   (no Enter key)
  reg.register(
    /^I type "([^"]*)" in (.+)$/i,
    async ([text, elementName], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      await typeText(loc, text!, scope);
    }
  );

  // I enter "<text>" in <element>   (text + press Enter)
  reg.register(
    /^I enter "([^"]*)" in (.+)$/i,
    async ([text, elementName], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      await typeText(loc, text!, scope);
      await loc.press('Enter');
    }
  );

  // I type <textRef> in <element>   (from named binding)
  reg.register(
    /^I type (.+) in (.+)$/i,
    async ([textRef, elementName], scope) => {
      const text = scope.get(textRef!.trim()) ?? textRef!.trim();
      const loc = await resolveLocator(elementName!.trim(), scope);
      await typeText(loc, text, scope);
    }
  );

  // I enter <textRef> in <element>   (from named binding, with Enter)
  reg.register(
    /^I enter (.+) in (.+)$/i,
    async ([textRef, elementName], scope) => {
      const text = scope.get(textRef!.trim()) ?? textRef!.trim();
      const loc = await resolveLocator(elementName!.trim(), scope);
      await typeText(loc, text, scope);
      await loc.press('Enter');
    }
  );

  // ─── Append ─────────────────────────────────────────────────────────────────

  // I append "<text>" to <element>
  reg.register(
    /^I append "([^"]*)" to (.+)$/i,
    async ([text, elementName], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      const current = await loc.inputValue();
      await loc.fill(current + text!);
    }
  );

  // I append <textRef> to <element>
  reg.register(
    /^I append (.+) to (.+)$/i,
    async ([textRef, elementName], scope) => {
      const text = scope.get(textRef!.trim()) ?? textRef!.trim();
      const loc = await resolveLocator(elementName!.trim(), scope);
      const current = await loc.inputValue();
      await loc.fill(current + text);
    }
  );

  // ─── Insert new line ─────────────────────────────────────────────────────────

  // I insert a new line in <textarea>
  reg.register(
    /^I insert a new line in (.+)$/i,
    async ([elementName], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      await loc.press('Shift+Enter');
    }
  );

  // ─── Highlight / Locate ──────────────────────────────────────────────────────

  // I locate <element>  — resolves element (validates it can be found)
  reg.register(
    /^I locate (.+)$/i,
    async ([elementName], scope) => {
      await resolveLocator(elementName!.trim(), scope);
    }
  );

  // I highlight <element>  — applies pgwen.web.highlight.style CSS for pgwen.web.throttle.msecs, then removes it
  reg.register(
    /^I highlight (.+)$/i,
    async ([elementName], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      const style = scope.get('pgwen.web.highlight.style') ?? 'background: yellow; border: 1px solid gold;';
      const throttleMs = parseInt(scope.get('pgwen.web.throttle.msecs') ?? '200', 10);
      await loc.evaluate((el: Element, s: string) => { (el as HTMLElement).style.cssText = s; }, style);
      await new Promise<void>(resolve => setTimeout(resolve, throttleMs));
      await loc.evaluate((el: Element) => { (el as HTMLElement).style.cssText = ''; });
    }
  );

  // ─── Key presses ─────────────────────────────────────────────────────────────

  // I press enter in <element>
  reg.register(
    /^I press enter in (.+)$/i,
    async ([elementName], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      await loc.press('Enter');
    }
  );

  // I press tab in <element>
  reg.register(
    /^I press tab in (.+)$/i,
    async ([elementName], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      await loc.press('Tab');
    }
  );

  // I send "<keys>" to <element>   e.g. "COMMAND+A", "CTRL+C"
  reg.register(
    /^I send "([^"]+)" to (.+)$/i,
    async ([keys, elementName], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      const playwrightKey = normaliseKeyCombo(keys!);
      await loc.press(playwrightKey);
    }
  );

  // ─── Clear ──────────────────────────────────────────────────────────────────

  // I clear <element>
  reg.register(
    /^I clear (.+)$/i,
    async ([elementName], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      await loc.clear();
    }
  );

  // ─── Scroll ─────────────────────────────────────────────────────────────────

  // I scroll to the top of the page
  reg.register(
    /^I scroll to the top of the page$/i,
    async (_, _scope, page) => {
      await (page as PageLike).evaluate('window.scrollTo(0, 0)');
    }
  );

  // I scroll to the bottom of the page
  reg.register(
    /^I scroll to the bottom of the page$/i,
    async (_, _scope, page) => {
      await (page as PageLike).evaluate('window.scrollTo(0, document.body.scrollHeight)');
    }
  );

  // I scroll to the top of <element>
  reg.register(
    /^I scroll to the top of (.+)$/i,
    async ([elementName], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await loc.evaluate((el: any) => (el as any).scrollTo(0, 0));
    }
  );

  // I scroll to the bottom of <element>
  reg.register(
    /^I scroll to the bottom of (.+)$/i,
    async ([elementName], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await loc.evaluate((el: any) => (el as any).scrollTo(0, (el as any).scrollHeight));
    }
  );

  // I scroll to <element>
  reg.register(
    /^I scroll to (.+)$/i,
    async ([elementName], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      await loc.scrollIntoViewIfNeeded();
    }
  );

  // ─── Drag ───────────────────────────────────────────────────────────────────

  // I drag and drop <source> to <target>   (-form — registered before the
  // shorter `I drag <source> to <target>` so its more-specific "and drop"
  // prefix wins the match)
  reg.register(
    /^I drag and drop (.+) to (.+)$/i,
    async ([sourceName, targetName], scope) => {
      const src = await resolveLocator(sourceName!.trim(), scope);
      const tgt = await resolveLocator(targetName!.trim(), scope);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (src as any).dragTo(tgt);
    }
  );

  // I drag <source> to <target>
  reg.register(
    /^I drag (?!and drop )(.+) to (.+)$/i,
    async ([sourceName, targetName], scope) => {
      const src = await resolveLocator(sourceName!.trim(), scope);
      const tgt = await resolveLocator(targetName!.trim(), scope);
      await src.dragTo(tgt);
    }
  );

  // ─── File upload ─────────────────────────────────────────────────────────────

  // I upload the file "<filepath>" to <element>
  reg.register(
    /^I upload the file "([^"]+)" to (.+)$/i,
    async ([filepath, elementName], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      await loc.dispatchEvent('input', { files: [filepath!] });
    }
  );

  // ─── Form submit ─────────────────────────────────────────────────────────────

  // I submit <element>  — submits the form containing (or being) the element
  reg.register(
    /^I submit (.+)$/i,
    async ([elementName], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await loc.evaluate((el: any) => {
        const form = el.tagName === 'FORM' ? el : el.closest('form');
        if (form) form.submit();
      });
    }
  );

  // ─── Base64 decode (element variant) ────────────────────────────────────────

  // I base64 decode <element|ref> [as <name>]
  // Reads either the element's text content OR the scope ref's value, decodes
  // from base64, and stores the result in scope (under <name>, or under the
  // source name if "as <name>" is omitted).
  reg.register(
    /^I base64 decode (.+) as (.+)$/i,
    async ([source, name], scope) => {
      const decoded = await decodeBase64From(source!.trim(), scope);
      scope.setTransparent(name!.trim(), decoded);
    }
  );

  reg.register(
    /^I base64 decode ([^"]+)$/i,
    async ([source], scope) => {
      const name = source!.trim();
      const decoded = await decodeBase64From(name, scope);
      scope.setTransparent(name, decoded);
    }
  );
}

async function decodeBase64From(
  source: string,
  scope: import('../../engine/Scope').Scope,
): Promise<string> {
  const locFn = scope.getLocator(source);
  if (locFn) {
    const loc = await locFn();
    const text = (await loc.textContent()) ?? '';
    return Buffer.from(text, 'base64').toString('utf-8');
  }
  const raw = scope.get(source) ?? '';
  return Buffer.from(raw, 'base64').toString('utf-8');
}

// ─── Type helper (respects pgwen.web.sendKeys.clearFirst / clickFirst) ────────

/**
 * Types text into a locator respecting sendKeys settings:
 *   pgwen.web.sendKeys.clearFirst  — default true  → fill() clears+sets; false → pressSequentially() appends
 *   pgwen.web.sendKeys.clickFirst  — default false → click element before typing when true
 */
async function typeText(
  loc: {
    fill(t: string): Promise<void>;
    pressSequentially(t: string): Promise<void>;
    click(): Promise<void>;
    setInputFiles?(p: string | string[]): Promise<void>;
    evaluate?<T>(fn: string | ((el: Element) => T)): Promise<T>;
  },
  text: string,
  scope: { get(name: string): string | undefined }
): Promise<void> {
  // <input type="file"> can't be driven by .fill()/.type() — Playwright
  // requires setInputFiles(). The locator's `.evaluate()` waits for the
  // element to be ATTACHED (not visible) so it works for styled file
  // inputs where the native control is hidden behind a custom button.
  // Failure (mock locator, detached node, etc.) falls through to the
  // normal type path. Use the full default timeout so async-rendered
  // forms (HTMX, Vue, etc.) have time to mount.
  if (typeof loc.evaluate === 'function' && typeof loc.setInputFiles === 'function') {
    let isFileInput = false;
    try {
      isFileInput = await loc.evaluate((el: Element) => {
        const e = el as HTMLInputElement;
        return e.tagName === 'INPUT' && (e.type || '').toLowerCase() === 'file';
      });
    } catch { /* mock locator / detached node — fall through to type path */ }
    if (isFileInput) {
      await loc.setInputFiles(text);
      return;
    }
  }

  const clearFirst = (scope.get('pgwen.web.sendKeys.clearFirst') ?? 'true') !== 'false';
  const clickFirst = (scope.get('pgwen.web.sendKeys.clickFirst') ?? 'false') === 'true';
  if (clickFirst) await loc.click();
  if (clearFirst) {
    await loc.fill(text);
  } else {
    await loc.pressSequentially(text);
  }
}

// ─── Key normalisation helpers ────────────────────────────────────────────────

/** Map /WebDriver-style key names to Playwright key names. */
function normaliseModifier(mod: string): string {
  switch (mod.toUpperCase()) {
    case 'COMMAND': case 'META': return 'Meta';
    case 'CONTROL': case 'CTRL': return 'Control';
    case 'ALT': return 'Alt';
    case 'SHIFT': return 'Shift';
    default: return mod;
  }
}

/** Convert "COMMAND+SHIFT+A" to Playwright key combo "Meta+Shift+A". */
function normaliseKeyCombo(keys: string): string {
  return keys.split('+').map(k => {
    const upper = k.toUpperCase();
    if (upper === 'COMMAND' || upper === 'META') return 'Meta';
    if (upper === 'CONTROL' || upper === 'CTRL') return 'Control';
    if (upper === 'ALT') return 'Alt';
    if (upper === 'SHIFT') return 'Shift';
    if (upper === 'ENTER') return 'Enter';
    if (upper === 'TAB') return 'Tab';
    if (upper === 'ESCAPE' || upper === 'ESC') return 'Escape';
    // Single char — preserve as-is
    return k.length === 1 ? k.toUpperCase() : k;
  }).join('+');
}
