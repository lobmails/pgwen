/**
 * src/diagnose/ai/AzureOpenAIAdapter.ts — Azure OpenAI adapter.
 *
 * Azure OpenAI is OpenAI's Chat Completions API behind a different
 * URL + auth header:
 *
 *   POST https://<resource>.openai.azure.com/openai/deployments/<deployment>/chat/completions?api-version=<v>
 *   api-key: <azure-api-key>
 *
 * Everything else — request body, function-call response shape, token
 * usage — is identical to OpenAI proper. So this adapter extends
 * `OpenAIAdapter` and only overrides `buildUrl()` + `buildHeaders()`.
 *
 * Azure AI gateway / enterprise deployments: a `baseUrl` override is
 * provided so projects behind a proxy can point at the gateway instead of
 * the public Azure endpoint. When `baseUrl` is set, the resource name
 * is ignored — the proxy already knows where to forward.
 */

import { OpenAIAdapter, type OpenAIAdapterOptions } from './OpenAIAdapter';
import type { AiProvider } from './types';

export interface AzureOpenAIAdapterOptions extends Omit<OpenAIAdapterOptions, 'baseUrl'> {
  /**
   * Azure resource name (e.g. "example-ai"). Combined with `deployment`
   * + `apiVersion` to form the endpoint URL. Ignored when `baseUrl` is
   * provided — the proxy / gateway already knows the resource.
   */
  resource?: string;
  /**
   * Deployment name (Azure's term for an "instance of a model"). Projects
   * configure via `pgwen.diagnose.ai.azureOpenai.deployment`. Required.
   */
  deployment: string;
  /**
   * API version, e.g. "2024-08-01-preview". Projects configure via
   * `pgwen.diagnose.ai.azureOpenai.apiVersion`. Required.
   */
  apiVersion: string;
  /**
   * Override the full base URL — useful for internal registry proxies that
   * route to Azure with auth rewriting. When set, `resource` is unused.
   */
  baseUrl?: string;
}

export class AzureOpenAIAdapter extends OpenAIAdapter {
  override readonly provider: AiProvider = 'azure-openai';
  private readonly deployment: string;
  private readonly apiVersion: string;
  private readonly resourceBase: string;

  constructor(opts: AzureOpenAIAdapterOptions) {
    if (!opts.deployment || opts.deployment.trim().length === 0) {
      throw new Error('AzureOpenAIAdapter requires a non-empty `deployment`.');
    }
    if (!opts.apiVersion || opts.apiVersion.trim().length === 0) {
      throw new Error('AzureOpenAIAdapter requires a non-empty `apiVersion`.');
    }
    if (!opts.baseUrl && (!opts.resource || opts.resource.trim().length === 0)) {
      throw new Error(
        'AzureOpenAIAdapter requires either `baseUrl` or `resource` ' +
        '(the Azure resource name, e.g. "example-ai").',
      );
    }
    // Resolve the base URL precedence: explicit baseUrl > resource.
    const baseUrl = opts.baseUrl
      ? opts.baseUrl.replace(/\/$/, '')
      : `https://${opts.resource!.trim()}.openai.azure.com`;

    // Forward to OpenAIAdapter with the resolved baseUrl + provider key
    // semantics; the parent only uses `apiKey` and `baseUrl` (which we
    // override via the URL builder below).
    super({ ...opts, baseUrl });
    this.deployment = opts.deployment.trim();
    this.apiVersion = opts.apiVersion.trim();
    this.resourceBase = baseUrl;
  }

  /**
   * Azure endpoint shape:
   *   <base>/openai/deployments/<deployment>/chat/completions?api-version=<v>
   */
  protected override buildUrl(): string {
    return (
      `${this.resourceBase}/openai/deployments/${encodeURIComponent(this.deployment)}` +
      `/chat/completions?api-version=${encodeURIComponent(this.apiVersion)}`
    );
  }

  /**
   * Azure auth: `api-key: <key>` (NOT `Authorization: Bearer`).
   * Some internal proxies layer an additional Authorization header on
   * top; projects provide that via `extraHeaders`.
   */
  protected override buildHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'api-key': this.getApiKey(),
      ...this.getExtraHeaders(),
    };
  }
}
