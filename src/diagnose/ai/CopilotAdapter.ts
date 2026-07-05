/**
 * src/diagnose/ai/CopilotAdapter.ts — GitHub Copilot adapter.
 *
 * Copilot's chat API is OpenAI-shaped (Chat Completions + function
 * calling) once a short-lived bearer is acquired from GitHub's token-
 * exchange endpoint. The user provides a GitHub PAT or App token
 * (`GITHUB_TOKEN`); we trade it for a Copilot session token that's
 * good for ~25 minutes, cache the result with its expiry, and use it
 * against `api.githubcopilot.com`.
 *
 * Token exchange:
 *   GET https://api.github.com/copilot_internal/v2/token
 *   Authorization: Bearer <GITHUB_TOKEN>
 *   → 200 { token: "tid_...", expires_at: 1729...  (unix seconds) }
 *
 * Chat request (OpenAI-compatible):
 *   POST https://api.githubcopilot.com/chat/completions
 *   Authorization: Bearer <copilot-token>
 *   Editor-Version: pgwen/<version>
 *   Editor-Plugin-Version: pgwen-fix/<version>
 *
 * Models: the user picks via `pgwen.diagnose.ai.copilot.model`. Common
 * choices: gpt-4o, gpt-4o-mini, claude-3.5-sonnet, o1-preview, o1-mini.
 *
 * On 401 (bearer expired or rotated): refresh + retry once.
 */

import type { PromptRequestBody } from '../Prompt';
import { REPORT_DIAGNOSIS_TOOL } from '../Prompt';
import type { AiCallResult, AiChatInput, AiChatResult, AiClient, AiProvider } from './types';
import {
  translateToOpenAI,
  parseOpenAIResponse,
  buildOpenAIChatBody,
  parseOpenAIChatResponse,
} from './OpenAIAdapter';

export interface CopilotAdapterOptions {
  /** GitHub PAT / App token used to obtain the Copilot session bearer. */
  githubToken: string;
  /** Default 'gpt-4o'. Overridable via `pgwen.diagnose.ai.copilot.model`. */
  model?: string;
  /** Default 'https://api.github.com'. */
  githubApiUrl?: string;
  /** Default 'https://api.githubcopilot.com'. */
  copilotApiUrl?: string;
  /** Max retries on 429 / 5xx / network. Default 3. */
  maxRetries?: number;
  /** Base delay between retries (ms). Default 1000. */
  retryBaseDelayMs?: number;
  /** Inject fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Inject sleep for backoff tests. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Editor identifier sent in Copilot headers. Default 'pgwen/1.0'. */
  editorVersion?: string;
  /**
   * Inject a clock for the expiry check. Defaults to `Date.now`. Useful
   * in tests to force-expire the cached token.
   */
  nowMs?: () => number;
}

export class CopilotError extends Error {
  override readonly name = 'CopilotError';
  constructor(
    message: string,
    readonly status?: number,
    readonly errorType?: string,
  ) {
    super(message);
  }
}

interface CopilotTokenResponse {
  token: string;
  /** Unix-seconds expiry. */
  expires_at: number;
}

/** Cached copilot session token + expiry. */
interface CachedToken {
  token: string;
  /** Unix-millis expiry. We refresh 60s early to avoid mid-call expiry. */
  expiresAtMs: number;
}

const REFRESH_LEAD_MS = 60_000; // refresh 1 minute before expiry

export class CopilotAdapter implements AiClient {
  readonly provider: AiProvider = 'copilot';
  private readonly githubToken: string;
  private readonly model: string;
  private readonly githubApiUrl: string;
  private readonly copilotApiUrl: string;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly editorVersion: string;
  private readonly nowMs: () => number;
  private cached: CachedToken | undefined;

  constructor(opts: CopilotAdapterOptions) {
    if (!opts.githubToken || typeof opts.githubToken !== 'string') {
      throw new CopilotError('CopilotAdapter requires a non-empty `githubToken`');
    }
    this.githubToken = opts.githubToken;
    this.model = opts.model ?? 'gpt-4o';
    this.githubApiUrl = (opts.githubApiUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.copilotApiUrl = (opts.copilotApiUrl ?? 'https://api.githubcopilot.com').replace(/\/$/, '');
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? 1000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleepImpl = opts.sleepImpl ?? defaultSleep;
    this.editorVersion = opts.editorVersion ?? 'pgwen/1.0';
    this.nowMs = opts.nowMs ?? (() => Date.now());
  }

  /**
   * Free-form chat for `pgwen:new`. Same body shape as OpenAI direct,
   * routed through the Copilot endpoint with the token-exchange dance.
   * Bearer caching + refresh logic is shared with `call()`.
   */
  async chat(input: AiChatInput): Promise<AiChatResult> {
    const url = `${this.copilotApiUrl}/chat/completions`;
    const body = buildOpenAIChatBody(input, this.model);
    const bearer = await this.getBearer();
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${bearer}`,
        'editor-version': this.editorVersion,
        'editor-plugin-version': this.editorVersion,
      },
      body: JSON.stringify(body),
    });
    if (response.status === 401) {
      // Bearer rotated mid-call; refresh + retry once.
      this.cached = undefined;
      const fresh = await this.getBearer();
      const retry = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${fresh}`,
          'editor-version': this.editorVersion,
          'editor-plugin-version': this.editorVersion,
        },
        body: JSON.stringify(body),
      });
      if (!retry.ok) {
        const text = await retry.text().catch(() => retry.statusText);
        throw new CopilotError(
          `Copilot chat HTTP ${retry.status} after bearer refresh: ${text.slice(0, 500)}`,
          retry.status,
        );
      }
      const json = await retry.json();
      return parseOpenAIChatResponse(json, 'copilot');
    }
    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new CopilotError(
        `Copilot chat HTTP ${response.status}: ${text.slice(0, 500)}`,
        response.status,
      );
    }
    const json = await response.json();
    return parseOpenAIChatResponse(json, 'copilot');
  }

  async call(body: PromptRequestBody): Promise<AiCallResult> {
    const openaiBody = translateToOpenAI(body, this.model);
    const url = `${this.copilotApiUrl}/chat/completions`;

    // One retry on 401 to handle bearer rotation: refresh the token, then
    // try once more. Beyond that, the standard 429/5xx retry loop kicks in.
    for (let bearerAttempt = 0; bearerAttempt < 2; bearerAttempt += 1) {
      const bearer = await this.getBearer();
      const result = await this.attemptCall(url, openaiBody, bearer);
      if (result.kind === 'ok') return result.value;
      if (result.kind === 'expired-bearer') {
        if (bearerAttempt === 0) {
          this.cached = undefined; // force refresh
          continue;
        }
        throw new CopilotError(
          'Copilot returned 401 after bearer refresh — check the GitHub token has Copilot access',
          401,
        );
      }
      // result.kind === 'error'
      throw result.error;
    }
    // Unreachable — the loop above either returns or throws.
    throw new CopilotError('CopilotAdapter: unreachable');
  }

  /**
   * One attempt loop with retries on 429 / 5xx / network. Returns
   * `expired-bearer` on 401 so `call()` can refresh and retry without
   * counting against the budget retry attempts.
   */
  private async attemptCall(
    url: string,
    openaiBody: object,
    bearer: string,
  ): Promise<
    | { kind: 'ok'; value: AiCallResult }
    | { kind: 'expired-bearer' }
    | { kind: 'error'; error: CopilotError }
  > {
    const init: RequestInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${bearer}`,
        'editor-version': this.editorVersion,
        'editor-plugin-version': this.editorVersion,
      },
      body: JSON.stringify(openaiBody),
    };

    let lastError: CopilotError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, init);
      } catch (err) {
        lastError = new CopilotError(
          `network error: ${err instanceof Error ? err.message : String(err)}`,
          undefined,
          'network_error',
        );
        if (attempt < this.maxRetries) {
          await this.sleepImpl(this.backoffMs(attempt));
          continue;
        }
        break;
      }

      if (response.ok) {
        const json = await response.json();
        const result = parseOpenAIResponse(json, REPORT_DIAGNOSIS_TOOL, 'copilot');
        return { kind: 'ok', value: result };
      }

      if (response.status === 401) {
        return { kind: 'expired-bearer' };
      }

      const status = response.status;
      const message = await safeReadErrorMessage(response);
      const retryable = status === 429 || (status >= 500 && status < 600);
      lastError = new CopilotError(message || `HTTP ${status}`, status);
      if (!retryable || attempt >= this.maxRetries) break;
      await this.sleepImpl(this.backoffMs(attempt));
    }

    return {
      kind: 'error',
      error:
        lastError ??
        new CopilotError(
          `Copilot /chat/completions failed after ${this.maxRetries + 1} attempt(s)`,
        ),
    };
  }

  /**
   * Return a valid Copilot session bearer. Reuses the cached one when
   * present + still ≥ REFRESH_LEAD_MS from expiry; otherwise exchanges
   * the GitHub token for a fresh one.
   */
  private async getBearer(): Promise<string> {
    if (this.cached && this.cached.expiresAtMs - this.nowMs() > REFRESH_LEAD_MS) {
      return this.cached.token;
    }
    return this.refreshBearer();
  }

  private async refreshBearer(): Promise<string> {
    const url = `${this.githubApiUrl}/copilot_internal/v2/token`;
    const init: RequestInit = {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${this.githubToken}`,
        'editor-version': this.editorVersion,
        'editor-plugin-version': this.editorVersion,
      },
    };

    let lastError: CopilotError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, init);
      } catch (err) {
        lastError = new CopilotError(
          `token-exchange network error: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (attempt < this.maxRetries) {
          await this.sleepImpl(this.backoffMs(attempt));
          continue;
        }
        break;
      }

      if (response.ok) {
        const json = (await response.json()) as CopilotTokenResponse;
        if (typeof json.token !== 'string' || typeof json.expires_at !== 'number') {
          throw new CopilotError(
            'token-exchange response missing required `token` / `expires_at` fields',
          );
        }
        this.cached = {
          token: json.token,
          expiresAtMs: json.expires_at * 1000,
        };
        return json.token;
      }

      const status = response.status;
      const retryable = status === 429 || (status >= 500 && status < 600);
      const message = await safeReadErrorMessage(response);
      lastError = new CopilotError(
        `token-exchange ${message || `HTTP ${status}`}`,
        status,
      );
      if (!retryable || attempt >= this.maxRetries) break;
      await this.sleepImpl(this.backoffMs(attempt));
    }

    throw lastError ?? new CopilotError('token-exchange failed');
  }

  private backoffMs(attempt: number): number {
    const base = this.retryBaseDelayMs * 2 ** attempt;
    const jitter = Math.floor(Math.random() * Math.min(250, base * 0.1));
    return base + jitter;
  }
}

async function safeReadErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.text();
    return body.slice(0, 500);
  } catch {
    return response.statusText;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
