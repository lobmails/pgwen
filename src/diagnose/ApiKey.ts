/**
 * ApiKey.ts — safe resolution of the Anthropic API key (§16 prerequisite).
 *
 * Precedence (highest first):
 *   1. Explicit override passed by the caller. Used in tests, or when
 *      another secret store has already retrieved the key.
 *   2. Environment variable. Name is configurable; defaults to
 *      `ANTHROPIC_API_KEY`. The env-var approach is RECOMMENDED — keys
 *      never end up on disk, survive across CI runs via standard secret
 *      stores (GitHub Actions secrets, AWS Secrets Manager, Vault, …).
 *   3. pgwen.conf value at `pgwen.diagnose.ai.api.key`. This MUST be
 *      declared with the `:masked` suffix so the HOCON loader redacts it
 *      in reports and console output. A non-masked entry still resolves
 *      (so a project doesn't hard-fail on a misconfigured pgwen.conf) but a
 *      warning is emitted and the caller should refuse to ship the
 *      config.
 *
 * The resolver NEVER logs, returns, or otherwise echoes the key value in
 * any field other than `key`. Errors use placeholders like `<redacted>`.
 */

export type Config = Record<string, string | undefined>;

export interface ResolveApiKeyOptions {
  /** Highest-precedence override. */
  override?: string;
  /** Env map; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Keys declared `<key>:masked` in pgwen.conf. Pass the
   * `maskedKeys` set from `loadLayeredWithMasked` here.
   */
  maskedKeys?: ReadonlySet<string>;
}

export interface ResolvedApiKey {
  /** The key value, or null when none was found. */
  key: string | null;
  /** Where the key came from. */
  source: 'override' | 'env' | 'config' | 'none';
  /** Non-fatal advisories about how the key was found. */
  warnings: string[];
}

const KEY_API_KEY_ENV = 'pgwen.diagnose.ai.api.keyEnv';
const KEY_API_KEY_CONFIG = 'pgwen.diagnose.ai.api.key';

export const DEFAULT_API_KEY_ENV = 'ANTHROPIC_API_KEY';

/**
 * Resolve the Anthropic API key from the configured sources. Always
 * returns a result — never throws — so the caller can decide whether
 * to skip Claude calls (when key=null) or surface the warnings.
 */
export function resolveApiKey(
  config: Config = {},
  opts: ResolveApiKeyOptions = {},
): ResolvedApiKey {
  const warnings: string[] = [];

  if (opts.override !== undefined) {
    if (opts.override.length === 0) {
      warnings.push('explicit override was an empty string; ignored');
    } else {
      return { key: opts.override, source: 'override', warnings };
    }
  }

  const env = opts.env ?? process.env;
  const envVarName = config[KEY_API_KEY_ENV]?.trim() || DEFAULT_API_KEY_ENV;
  const fromEnv = env[envVarName];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return { key: fromEnv, source: 'env', warnings };
  }

  const fromConfig = config[KEY_API_KEY_CONFIG];
  if (typeof fromConfig === 'string' && fromConfig.length > 0) {
    if (!opts.maskedKeys?.has(KEY_API_KEY_CONFIG)) {
      warnings.push(
        `${KEY_API_KEY_CONFIG} is set in pgwen.conf but NOT declared :masked — ` +
        `the value can appear in reports and logs. Either prefix with \`:masked\` ` +
        `(e.g. \`pgwen.diagnose.ai.api."key:masked" = "sk-..."\`) or move the key ` +
        `to the ${envVarName} env var.`,
      );
    }
    return { key: fromConfig, source: 'config', warnings };
  }

  warnings.push(
    `No API key found. Set the ${envVarName} env var, or declare ` +
    `\`${KEY_API_KEY_CONFIG}:masked\` in pgwen.conf, or pass \`override\` programmatically.`,
  );
  return { key: null, source: 'none', warnings };
}

/**
 * Convenience: return a short, redacted descriptor for the resolved
 * key suitable for logging — e.g. `env:sk-ant-...3f2a` — so callers
 * can prove which source won precedence without exposing the secret.
 */
export function describeResolvedKey(resolved: ResolvedApiKey): string {
  if (resolved.key === null) return `${resolved.source}:<none>`;
  const fingerprint = resolved.key.length <= 8
    ? '<short>'
    : `${resolved.key.slice(0, 3)}...${resolved.key.slice(-4)}`;
  return `${resolved.source}:${fingerprint}`;
}
