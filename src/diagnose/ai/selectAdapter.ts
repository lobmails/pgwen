/**
 * src/diagnose/ai/selectAdapter.ts — provider factory.
 *
 * Resolves an AI provider from (a) `pgwen.diagnose.ai.provider` config
 * and (b) the optional `--provider` CLI flag. Returns the matching
 * adapter constructed with provider-appropriate options.
 *
 * Phase A: only ClaudeAdapter is wired. The factory's enum + error
 * messages already cover OpenAI / Azure / Copilot so subsequent phases
 * only need to wire their adapter into the switch.
 *
 * The resolver is intentionally tolerant: unknown / empty provider falls
 * back to "claude" (the historical default). Projects upgrading from earlier
 * pgwen versions see no behaviour change.
 */

import { ClaudeAdapter } from './ClaudeAdapter';
import { OpenAIAdapter } from './OpenAIAdapter';
import { AzureOpenAIAdapter } from './AzureOpenAIAdapter';
import { CopilotAdapter } from './CopilotAdapter';
import { MockAdapter, type MockFixtures } from './MockAdapter';
import type { AiClient, AiProvider } from './types';

export interface SelectAdapterOpts {
  /**
   * Provider name. Falls back to "claude" when undefined / empty.
   * Unrecognised values throw — typo'd config should fail loud.
   */
  provider?: string;
  /**
   * API key for the chosen provider. Adapter-specific:
   *   claude       — Anthropic key
   *   openai       — OpenAI key
   *   azure-openai — Azure OpenAI api-key
   *   copilot      — GitHub PAT (used to fetch the short-lived Copilot bearer)
   */
  apiKey: string;
  /**
   * Optional model override. Each provider has its own default model;
   * setting this here forces it.
   */
  model?: string;
  /**
   * Override base URL. Useful for Azure (deployment-specific endpoint)
   * or for self-hosted gateways that proxy a provider's API.
   */
  baseUrl?: string;
  /** Inject `fetch` for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Inject sleep for backoff tests; defaults to setTimeout-based. */
  sleepImpl?: (ms: number) => Promise<void>;
  /**
   * Provider-specific extras keyed under each provider name. Avoids
   * polluting the top-level options shape with fields only one provider
   * uses (e.g. Azure's `deployment` + `apiVersion`).
   */
  azureOpenai?: {
    resource?: string;
    deployment: string;
    apiVersion: string;
  };
  /**
   * Mock-adapter options — used ONLY when `provider === 'mock'` (CLI / env
   * opt-in). Production providers ignore this field. Inline `fixtures`
   * preferred in unit tests; `fixturesPath` (or PGWEN_AI_MOCK_FIXTURES env
   * var, read by the adapter itself) for CLI / integration tests.
   */
  mock?: {
    fixtures?: MockFixtures;
    fixturesPath?: string;
    impersonateProvider?: AiProvider;
  };
}

const KNOWN_PROVIDERS: ReadonlySet<AiProvider> = new Set([
  'claude',
  'openai',
  'azure-openai',
  'copilot',
]);

/**
 * Validate + normalise a provider string into an `AiProvider` enum value.
 * Empty / undefined returns the default ("claude"). Unrecognised values
 * throw — typos in config should fail loud, not silently fall back.
 */
export function resolveProvider(raw: string | undefined): AiProvider {
  if (raw === undefined || raw.trim().length === 0) return 'claude';
  const normalised = raw.toLowerCase().trim();
  if (!KNOWN_PROVIDERS.has(normalised as AiProvider)) {
    throw new Error(
      `Unknown AI provider: "${raw}". ` +
      `Accepted values: ${Array.from(KNOWN_PROVIDERS).join(', ')}.`,
    );
  }
  return normalised as AiProvider;
}

/**
 * Build the adapter for the resolved provider. Throws when the provider
 * is recognised but not yet implemented in this version of pgwen — gives
 * the user a clean upgrade path rather than a cryptic "undefined is not
 * a function".
 */
export function selectAdapter(opts: SelectAdapterOpts): AiClient {
  // Mock escape hatch — gated BEFORE production resolveProvider so the
  // `AiProvider` enum stays clean. Opt-in only via explicit "mock" string
  // on the --provider flag or PGWEN_AI_PROVIDER env var. Never reached
  // under normal CLI invocation.
  const explicitMock =
    opts.provider === 'mock' ||
    (opts.provider === undefined && process.env.PGWEN_AI_PROVIDER === 'mock');
  if (explicitMock) {
    return new MockAdapter({
      ...(opts.mock?.fixtures !== undefined ? { fixtures: opts.mock.fixtures } : {}),
      ...(opts.mock?.fixturesPath !== undefined ? { fixturesPath: opts.mock.fixturesPath } : {}),
      ...(opts.mock?.impersonateProvider !== undefined
        ? { impersonateProvider: opts.mock.impersonateProvider }
        : {}),
    });
  }

  const provider = resolveProvider(opts.provider);

  switch (provider) {
    case 'claude':
      return new ClaudeAdapter({
        apiKey: opts.apiKey,
        ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.sleepImpl !== undefined ? { sleepImpl: opts.sleepImpl } : {}),
      });

    case 'openai':
      return new OpenAIAdapter({
        apiKey: opts.apiKey,
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.sleepImpl !== undefined ? { sleepImpl: opts.sleepImpl } : {}),
      });

    case 'azure-openai': {
      if (!opts.azureOpenai) {
        throw new Error(
          'AI provider "azure-openai" requires `azureOpenai.deployment` + ' +
          '`azureOpenai.apiVersion` (and `azureOpenai.resource` unless `baseUrl` is set). ' +
          'Config keys: pgwen.diagnose.ai.azureOpenai.{resource,deployment,apiVersion}.',
        );
      }
      return new AzureOpenAIAdapter({
        apiKey: opts.apiKey,
        deployment: opts.azureOpenai.deployment,
        apiVersion: opts.azureOpenai.apiVersion,
        ...(opts.azureOpenai.resource !== undefined ? { resource: opts.azureOpenai.resource } : {}),
        ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.sleepImpl !== undefined ? { sleepImpl: opts.sleepImpl } : {}),
      });
    }

    case 'copilot':
      return new CopilotAdapter({
        // For Copilot the `apiKey` slot carries the user's GITHUB_TOKEN —
        // the adapter exchanges it for a short-lived Copilot bearer.
        githubToken: opts.apiKey,
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.sleepImpl !== undefined ? { sleepImpl: opts.sleepImpl } : {}),
      });
  }
}
