/**
 * ProfileLoader.ts — Load layered HOCON / JSON / .properties config files.
 *
 * config hierarchy (lowest → highest precedence):
 *   7. defaults (built-in)
 *   6. pgwen.conf  (project root)
 *   5. -c conf-file (launch settings)
 *   4. -p profileName → conf/profiles/<name>.conf
 *   3. ~/pgwen.conf (user settings)
 *   2. Environment variables  (handled by StringInterpolator, not here)
 *   1. System properties      (handled by StringInterpolator, not here)
 *
 * loadLayered() accepts an ordered array of file paths (lowest precedence first).
 * Returns a flat Record<string, string> — all values normalised to strings.
 *
 * Supported formats:
 *   .conf        → HOCON (subset: block objects, = or : separator, # // comments)
 *   .json        → standard JSON
 *   .properties  → Java-style key=value
 *
 * HOCON subset supported (covers all known config patterns):
 *   - Block objects:        key { ... }
 *   - Key-value:            key = value  or  key: value
 *   - Nested dot keys:      pgwen.web.wait.seconds = 10
 *   - Quoted keys:          "key:masked" = value
 *   - String values:        quoted "string" or unquoted string (no spaces needed)
 *   - Multiline strings:    """..."""
 *   - Numbers & booleans:   10 / true / false / null
 *   - Arrays:               [ "a", "b" ]  or  []
 *   - Empty objects:        {}
 *   - Line comments:        # ...  or  // ...
 *   - Block comments:       slash-star ... star-slash
 *   - include "file.conf"   (resolved relative to the including file)
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Public API ───────────────────────────────────────────────────────────────

export type Config = Record<string, string>;

/**
 * Result from loadLayeredWithMasked — includes the flat config (masked keys
 * stripped of their `:masked` suffix) plus the set of keys that were declared
 * as masked in one or more config files.
 */
export interface LoadResult {
  config: Config;
  /** Keys declared with the `:masked` suffix in any config file. */
  maskedKeys: ReadonlySet<string>;
}

/**
 * Load and merge a list of config files, lowest-precedence first.
 * Later files override keys from earlier files.
 *
 * A final substitution pass is run on the merged result so that cross-file
 * references work correctly — e.g. pgwen.baseDir defined in pgwen.conf and
 * referenced as ${pgwen.baseDir} in a profile conf.
 */
export function loadLayered(filePaths: string[]): Config {
  return loadLayeredWithMasked(filePaths).config;
}

/**
 * Same as loadLayered but also returns the set of keys that were declared
 * with the `:masked` suffix across all loaded files.
 * Keys are stored WITHOUT the `:masked` suffix — e.g. `newRelic.apiKey:masked`
 * is accessible as `${newRelic.apiKey}` and appears in maskedKeys as
 * `"newRelic.apiKey"`.
 */
export function loadLayeredWithMasked(filePaths: string[]): LoadResult {
  let mergedConfig: Config = {};
  const mergedMasked = new Set<string>();

  for (const filePath of filePaths) {
    const { config, maskedKeys } = loadFileWithMasked(filePath);
    mergedConfig = { ...mergedConfig, ...config };
    for (const k of maskedKeys) mergedMasked.add(k);
  }

  return {
    config: resolveSubstitutions(mergedConfig),
    maskedKeys: mergedMasked,
  };
}

/**
 * Load a single config file.
 * The format is inferred from the file extension.
 * Keys declared with `:masked` suffix are stripped to their plain name.
 */
export function loadFile(filePath: string): Config {
  return loadFileWithMasked(filePath).config;
}

/**
 * Same as loadFile but also returns which keys were declared with `:masked`.
 */
export function loadFileWithMasked(filePath: string): LoadResult {
  const resolved = path.resolve(filePath);
  let content: string;
  try {
    content = fs.readFileSync(resolved, 'utf-8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigLoadError(`Cannot read config file "${resolved}": ${msg}`);
  }

  const ext = path.extname(resolved).toLowerCase();
  const dir = path.dirname(resolved);

  let config: Config;
  if (ext === '.json') {
    config = parseJson(content, resolved);
  } else if (ext === '.properties') {
    config = parseProperties(content);
  } else {
    // .conf, .hocon, or anything else → HOCON
    config = parseHocon(content, resolved, dir);
  }

  // Separate masked keys (keys that ended with ':masked') from plain keys.
  // The flat() + HOCON parsers already stored them with their full dotted name
  // including the ':masked' suffix — strip it here to produce plain names.
  const plainConfig: Config = {};
  const maskedKeys = new Set<string>();
  for (const [k, v] of Object.entries(config)) {
    if (k.endsWith(':masked')) {
      const plain = k.slice(0, -7); // strip ':masked'
      plainConfig[plain] = v;
      maskedKeys.add(plain);
    } else {
      plainConfig[k] = v;
    }
  }
  return { config: plainConfig, maskedKeys };
}

/**
 * Parse config from a HOCON string (no file I/O — useful for testing).
 */
export function parseHoconSource(content: string, uri = '<source>'): Config {
  return parseHocon(content, uri, '.');
}

// ─── JSON parser ──────────────────────────────────────────────────────────────

function parseJson(content: string, uri: string): Config {
  let obj: unknown;
  try {
    obj = JSON.parse(content);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigLoadError(`Invalid JSON in "${uri}": ${msg}`);
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new ConfigLoadError(`JSON config "${uri}" must be a top-level object.`);
  }
  return flatten(obj as Record<string, unknown>);
}

// ─── Properties parser ────────────────────────────────────────────────────────

function parseProperties(content: string): Config {
  const result: Config = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const eqIdx = line.indexOf('=');
    const colonIdx = line.indexOf(':');
    const sepIdx =
      eqIdx === -1 ? colonIdx :
      colonIdx === -1 ? eqIdx :
      Math.min(eqIdx, colonIdx);
    if (sepIdx === -1) continue;
    const key = line.slice(0, sepIdx).trim();
    const value = line.slice(sepIdx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

// ─── HOCON parser ─────────────────────────────────────────────────────────────

/**
 * Pre-process HOCON content to protect ${...} substitution references in
 * value positions. Wraps them in quotes so the tokeniser sees them as strings.
 * Pattern: after = or :, an unquoted value starting with ${...}
 */
function protectSubstitutions(content: string): string {
  // Match value positions (after = or :) that start with ${...} possibly followed by more chars
  return content.replace(
    /((?:=|:)\s*)(\$\{[^}\n]+\}[^\n"#{}[\]]*)/gm,
    (_, sep: string, val: string) => `${sep}"${val.trimEnd()}"`
  );
}

/**
 * Post-process: resolve ${key} references in config values.
 * Iterates until no more substitutions can be made (up to 5 passes).
 */
/**
 * Sentinel used to mark optional substitutions whose env var is not defined.
 * Keys that resolve to this sentinel are deleted after all passes complete,
 * which replicates HOCON's ${?VAR} semantics: if the variable is absent, the
 * entire key assignment is silently ignored (not overwritten with empty string).
 */
const OPTIONAL_UNSET = '\u0000__PGWEN_OPTIONAL_UNSET__\u0000';

function resolveSubstitutions(config: Config): Config {
  const result = { ...config };

  for (let pass = 0; pass < 5; pass++) {
    let changed = false;

    for (const [k, v] of Object.entries(result)) {
      const resolved = v.replace(/\$\{([^}]+)\}/g, (_m: string, ref: string) => {
        // ${?VAR} — HOCON optional substitution: check env var; if not set, mark for removal
        if (ref.startsWith('?')) {
          const varName = ref.slice(1).trim();
          const envVal = process.env[varName];
          return envVal !== undefined ? envVal : OPTIONAL_UNSET;
        }

        // ${env.VAR} — explicit env var reference
        if (ref.startsWith('env.')) {
          const varName = ref.slice(4);
          const envVal = process.env[varName];
          return envVal !== undefined ? envVal : '';
        }

        // ${key} — look up in parsed config first, then env var as fallback
        const refVal = result[ref];
        if (refVal !== undefined) return refVal;
        const envVal = process.env[ref];
        return envVal !== undefined ? envVal : _m;
      });

      if (resolved !== v) {
        result[k] = resolved;
        changed = true;
      }
    }

    if (!changed) break;
  }

  // Remove keys whose entire value resolved to the optional-unset sentinel.
  // This mirrors HOCON: `key = ${?MISSING_VAR}` is treated as if the line
  // was never written — preserving any value set by a lower-precedence file.
  for (const k of Object.keys(result)) {
    if (result[k] === OPTIONAL_UNSET) {
      delete result[k];
    }
  }

  return result;
}

function parseHocon(content: string, uri: string, baseDir: string): Config {
  // Phase 1: strip comments
  const stripped = stripComments(content);

  // Phase 1b: protect ${...} substitution references from the tokeniser
  const protected_ = protectSubstitutions(stripped);

  // Phase 2: parse into a nested object
  let obj: Record<string, unknown>;
  try {
    const tokens = tokenise(protected_);
    const { value } = parseObject(tokens, 0, true);
    obj = value as Record<string, unknown>;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigLoadError(`Failed to parse HOCON in "${uri}": ${msg}`);
  }

  // Phase 3: handle include directives
  const base = flatten(obj);

  const includes = extractIncludes(stripped);
  let merged = base;
  for (const includePath of includes) {
    const resolved = path.resolve(baseDir, includePath);
    if (fs.existsSync(resolved)) {
      const included = loadFile(resolved);
      merged = { ...merged, ...included };
    }
  }

  // Phase 4: resolve ${key} substitutions in string values
  return resolveSubstitutions(merged);
}

// ─── HOCON tokeniser ─────────────────────────────────────────────────────────

type Token =
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'null' }
  | { type: '{' }
  | { type: '}' }
  | { type: '[' }
  | { type: ']' }
  | { type: ',' }
  | { type: 'sep' }          // = or :
  | { type: 'newline' }
  | { type: 'key'; value: string };

function tokenise(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;

    if (ch === ' ' || ch === '\r' || ch === '\t') { i++; continue; }
    if (ch === '\n') { tokens.push({ type: 'newline' }); i++; continue; }
    if (ch === '{') { tokens.push({ type: '{' }); i++; continue; }
    if (ch === '}') { tokens.push({ type: '}' }); i++; continue; }
    if (ch === '[') { tokens.push({ type: '[' }); i++; continue; }
    if (ch === ']') { tokens.push({ type: ']' }); i++; continue; }
    if (ch === ',') { tokens.push({ type: ',' }); i++; continue; }
    if (ch === '=' || ch === ':') { tokens.push({ type: 'sep' }); i++; continue; }

    // Triple-quoted string
    if (ch === '"' && input[i + 1] === '"' && input[i + 2] === '"') {
      i += 3;
      const start = i;
      while (i < input.length && !(input[i] === '"' && input[i + 1] === '"' && input[i + 2] === '"')) {
        i++;
      }
      tokens.push({ type: 'string', value: input.slice(start, i).trim() });
      i += 3;
      continue;
    }

    // Quoted string
    if (ch === '"') {
      i++;
      let s = '';
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\') { i++; s += unescapeChar(input[i] ?? ''); }
        else { s += input[i]; }
        i++;
      }
      i++; // closing "
      tokens.push({ type: 'string', value: s });
      continue;
    }

    // Number
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let numStr = '';
      while (i < input.length && /[-\d.eE+]/.test(input[i]!)) {
        numStr += input[i++];
      }
      const n = Number(numStr);
      if (!isNaN(n)) {
        tokens.push({ type: 'number', value: n });
      } else {
        tokens.push({ type: 'string', value: numStr });
      }
      continue;
    }

    // Unquoted keyword or bare string value
    if (/[a-zA-Z_$\-.]/.test(ch)) {
      let word = '';
      while (i < input.length && /[a-zA-Z0-9_$.\-]/.test(input[i]!)) {
        word += input[i++];
      }
      if (word === 'true')  { tokens.push({ type: 'boolean', value: true });  continue; }
      if (word === 'false') { tokens.push({ type: 'boolean', value: false }); continue; }
      if (word === 'null')  { tokens.push({ type: 'null' });                  continue; }
      tokens.push({ type: 'key', value: word });
      continue;
    }

    i++; // skip unrecognised char
  }
  return tokens;
}

function unescapeChar(ch: string): string {
  switch (ch) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    default: return ch;
  }
}

// ─── HOCON recursive-descent parser ─────────────────────────────────────────

type ParseResult<T> = { value: T; pos: number };

function parseObject(
  tokens: Token[],
  pos: number,
  topLevel = false
): ParseResult<Record<string, unknown>> {
  const obj: Record<string, unknown> = {};

  // Consume opening { (unless top-level)
  if (!topLevel) {
    pos = skipNewlines(tokens, pos);
    if (tokens[pos]?.type !== '{') throw new Error(`Expected '{' at token ${pos}`);
    pos++;
  }

  while (pos < tokens.length) {
    pos = skipNewlines(tokens, pos);
    const tok = tokens[pos];
    if (!tok) break;

    // End of object
    if (tok.type === '}') { pos++; break; }
    if (tok.type === ',') { pos++; continue; }

    // Key
    if (tok.type !== 'key' && tok.type !== 'string') {
      pos++; continue; // skip unexpected token
    }

    const rawKey = tok.value as string;
    pos++;
    pos = skipNewlines(tokens, pos);

    const next = tokens[pos];

    // Nested block object:  key { ... }
    if (next?.type === '{') {
      const { value: nested, pos: newPos } = parseObject(tokens, pos);
      // Merge nested into obj under rawKey prefix
      for (const [k, v] of Object.entries(nested)) {
        obj[`${rawKey}.${k}`] = v;
      }
      pos = newPos;
      continue;
    }

    // Separator:  key = value  or  key: value
    if (next?.type === 'sep') {
      pos++;
      pos = skipNewlines(tokens, pos);
      const { value: val, pos: newPos } = parseValue(tokens, pos);
      obj[rawKey] = val;
      pos = newPos;
      continue;
    }

    // Key with no value (rare) — skip
    continue;
  }

  return { value: obj, pos };
}

function parseValue(tokens: Token[], pos: number): ParseResult<unknown> {
  pos = skipNewlines(tokens, pos);
  const tok = tokens[pos];
  if (!tok) return { value: null, pos };

  if (tok.type === 'string')  return { value: tok.value, pos: pos + 1 };
  if (tok.type === 'number')  return { value: tok.value, pos: pos + 1 };
  if (tok.type === 'boolean') return { value: tok.value, pos: pos + 1 };
  if (tok.type === 'null')    return { value: null, pos: pos + 1 };
  if (tok.type === 'key')     return { value: tok.value, pos: pos + 1 };

  if (tok.type === '{') {
    return parseObject(tokens, pos);
  }

  if (tok.type === '[') {
    return parseArray(tokens, pos);
  }

  return { value: null, pos: pos + 1 };
}

function parseArray(tokens: Token[], pos: number): ParseResult<unknown[]> {
  pos++; // consume [
  const arr: unknown[] = [];

  while (pos < tokens.length) {
    pos = skipNewlines(tokens, pos);
    const tok = tokens[pos];
    if (!tok || tok.type === ']') { pos++; break; }
    if (tok.type === ',') { pos++; continue; }

    const { value, pos: newPos } = parseValue(tokens, pos);
    arr.push(value);
    pos = newPos;
  }

  return { value: arr, pos };
}

function skipNewlines(tokens: Token[], pos: number): number {
  while (tokens[pos]?.type === 'newline' || tokens[pos]?.type === ',') pos++;
  return pos;
}

// ─── Comment stripping ────────────────────────────────────────────────────────

function stripComments(input: string): string {
  let result = '';
  let i = 0;
  while (i < input.length) {
    // Block comment
    if (input[i] === '/' && input[i + 1] === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // Line comment: // or #
    if ((input[i] === '/' && input[i + 1] === '/') || input[i] === '#') {
      while (i < input.length && input[i] !== '\n') i++;
      continue;
    }
    // Triple-quoted string — preserve verbatim
    if (input[i] === '"' && input[i + 1] === '"' && input[i + 2] === '"') {
      result += '"""';
      i += 3;
      while (i < input.length && !(input[i] === '"' && input[i + 1] === '"' && input[i + 2] === '"')) {
        result += input[i++];
      }
      result += '"""';
      i += 3;
      continue;
    }
    // Regular quoted string — preserve verbatim
    if (input[i] === '"') {
      result += input[i++];
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\') { result += input[i++]; }
        result += input[i++];
      }
      result += input[i++]; // closing "
      continue;
    }
    result += input[i++];
  }
  return result;
}

function extractIncludes(content: string): string[] {
  const includes: string[] = [];
  const re = /\binclude\s+"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    includes.push(m[1]!);
  }
  return includes;
}

// ─── Flatten nested object to dotted keys ────────────────────────────────────

function flatten(obj: Record<string, unknown>, prefix = ''): Config {
  const result: Config = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.assign(result, flatten(value as Record<string, unknown>, fullKey));
    } else if (Array.isArray(value)) {
      result[fullKey] = JSON.stringify(value);
    } else if (value === null) {
      result[fullKey] = '';
    } else {
      result[fullKey] = String(value);
    }
  }
  return result;
}

// ─── Error type ───────────────────────────────────────────────────────────────

export class ConfigLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigLoadError';
  }
}
