/**
 * src/diagnose/ai/OpenAIAdapter.ts — OpenAI Chat Completions adapter.
 *
 * Talks to `https://api.openai.com/v1/chat/completions` with function
 * calling forced to the `report_diagnosis` tool. Translates the
 * Anthropic-shaped `PromptRequestBody` the rest of pgwen produces into
 * OpenAI's wire format and back: tool definitions become functions,
 * tool_choice gets converted, the assistant's function-call arguments
 * (a JSON string in OpenAI) parse back into a `DiagnoseOutput`.
 *
 * Auth: `Authorization: Bearer <apiKey>` (OPENAI_API_KEY env). No
 * separate API-version header.
 *
 * Retries: identical policy to ClaudeAdapter — 429 + 5xx + network
 * errors retried with exponential backoff + jitter; Retry-After
 * honoured; 4xx (non-429) fail fast.
 *
 * Phase C `AzureOpenAIAdapter` reuses this adapter's translation +
 * parsing helpers (exported below) and only overrides URL construction
 * + the auth header.
 */

import type { PromptRequestBody } from '../Prompt';
import { REPORT_DIAGNOSIS_TOOL } from '../Prompt';
import type { DiagnoseOutput } from '../types';
import type { AiCallResult, AiChatInput, AiChatResult, AiClient, AiProvider } from './types';
import { isValidDiagnoseOutput } from './validator';

const DEFAULT_CHAT_MODEL = 'gpt-4o-2024-08-06';

// ─── Public types ──────────────────────────────────────────────────────────

export interface OpenAIAdapterOptions {
  apiKey: string;
  /** Default 'https://api.openai.com'. */
  baseUrl?: string;
  /**
   * Model to send on every call. Defaults to 'gpt-4o-2024-08-06'.
   * Projects override via `pgwen.diagnose.ai.openai.model`. The model in
   * the inbound `PromptRequestBody.model` field is ignored — that's the
   * Anthropic model id and doesn't apply here.
   */
  model?: string;
  /** Default 3 retries on 429 / 5xx / network errors. */
  maxRetries?: number;
  /** Base delay between retries (ms); doubles each attempt. Default 1000. */
  retryBaseDelayMs?: number;
  /** Inject `fetch` for tests. */
  fetchImpl?: typeof fetch;
  /** Inject a sleep fn for backoff tests. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Extend headers (e.g. for proxies). */
  extraHeaders?: Record<string, string>;
}

export class OpenAIError extends Error {
  override readonly name = 'OpenAIError';
  constructor(
    message: string,
    readonly status?: number,
    readonly errorType?: string,
    readonly attempts?: number,
  ) {
    super(message);
  }
}

// ─── OpenAI wire shapes (subset we use) ────────────────────────────────────

interface OpenAIToolChoice {
  type: 'function';
  function: { name: string };
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIRequestBody {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  tools: OpenAITool[];
  tool_choice: OpenAIToolChoice;
  max_tokens: number;
  temperature?: number;
}

interface OpenAIResponse {
  id: string;
  model: string;
  choices: Array<{
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

interface OpenAIErrorEnvelope {
  error?: { message: string; type?: string; code?: string };
}

// ─── Adapter ───────────────────────────────────────────────────────────────

export class OpenAIAdapter implements AiClient {
  readonly provider: AiProvider = 'openai';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: OpenAIAdapterOptions) {
    if (!opts.apiKey || typeof opts.apiKey !== 'string') {
      throw new OpenAIError('OpenAIAdapter requires a non-empty apiKey');
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com').replace(/\/$/, '');
    this.model = opts.model ?? 'gpt-4o-2024-08-06';
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? 1000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleepImpl = opts.sleepImpl ?? defaultSleep;
    this.extraHeaders = opts.extraHeaders ?? {};
  }

  async call(body: PromptRequestBody): Promise<AiCallResult> {
    const url = this.buildUrl();
    const openaiBody = translateToOpenAI(body, this.model);
    const headers: Record<string, string> = this.buildHeaders();
    const init: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify(openaiBody),
    };

    let lastError: OpenAIError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, init);
      } catch (err) {
        lastError = new OpenAIError(
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
        const json = (await response.json()) as OpenAIResponse;
        return parseOpenAIResponse(json, REPORT_DIAGNOSIS_TOOL, this.provider);
      }

      const status = response.status;
      const errorInfo = await safeReadError(response);
      const retryable = status === 429 || (status >= 500 && status < 600);
      lastError = new OpenAIError(
        errorInfo.message || `HTTP ${status}`,
        status,
        errorInfo.errorType,
      );

      if (!retryable || attempt >= this.maxRetries) break;
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      await this.sleepImpl(retryAfter ?? this.backoffMs(attempt));
    }

    const attempts = this.maxRetries + 1;
    throw new OpenAIError(
      `OpenAI /v1/chat/completions failed after ${attempts} attempt(s): ${lastError?.message ?? 'unknown error'}`,
      lastError?.status,
      lastError?.errorType,
      attempts,
    );
  }

  /**
   * Free-form conversational chat — no forced function call. Used by
   * `pgwen:new`. Subclasses (Azure, Copilot) inherit this method
   * unchanged: it uses the protected `buildUrl()` + `buildHeaders()` hooks
   * the same way `call()` does.
   *
   * Images: OpenAI accepts vision input via image_url content parts on
   * the user message. Base64 data URLs are passed through directly —
   * the API supports them on gpt-4o + gpt-4o-mini.
   */
  async chat(input: AiChatInput): Promise<AiChatResult> {
    const url = this.buildUrl();
    const body = buildOpenAIChatBody(input, this.model);
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new OpenAIError(
        `OpenAI chat HTTP ${response.status}: ${text.slice(0, 500)}`,
        response.status,
      );
    }
    const json = (await response.json()) as OpenAIChatResponse;
    return parseOpenAIChatResponse(json, this.provider);
  }

  /** Subclasses (AzureOpenAIAdapter) override to use api-key header. */
  protected buildHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
      ...this.extraHeaders,
    };
  }

  /**
   * Subclasses (AzureOpenAIAdapter) override to use the deployment-
   * specific endpoint instead of the standard /v1/chat/completions path.
   */
  protected buildUrl(): string {
    return `${this.baseUrl}/v1/chat/completions`;
  }

  /** Exposed for subclasses that need read-only access. */
  protected getApiKey(): string {
    return this.apiKey;
  }
  protected getExtraHeaders(): Record<string, string> {
    return this.extraHeaders;
  }

  private backoffMs(attempt: number): number {
    const base = this.retryBaseDelayMs * 2 ** attempt;
    const jitter = Math.floor(Math.random() * Math.min(250, base * 0.1));
    return base + jitter;
  }
}

// ─── Pure helpers (exported for direct tests + Phase C reuse) ──────────────

/**
 * Translate an Anthropic-shaped PromptRequestBody to OpenAI's Chat
 * Completions request format. Lossy by design: `cache_control` hints
 * are dropped (OpenAI handles prompt caching automatically on gpt-4o
 * once the prompt exceeds 1024 tokens — no opt-in needed). The Anthropic
 * `system` field (an array of TextBlocks) is concatenated into a single
 * system message string; OpenAI doesn't support content blocks for the
 * system role.
 */
export function translateToOpenAI(body: PromptRequestBody, model: string): OpenAIRequestBody {
  // System: flatten the TextBlock array into one string.
  const systemContent = body.system
    .map((s) => (typeof s === 'string' ? s : s.text ?? ''))
    .filter((s) => s.length > 0)
    .join('\n\n');

  const messages: OpenAIRequestBody['messages'] = [];
  if (systemContent.length > 0) {
    messages.push({ role: 'system', content: systemContent });
  }
  for (const m of body.messages) {
    messages.push({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : extractTextFromBlocks(m.content),
    });
  }

  // Tools: rename input_schema → function.parameters; drop cache_control.
  const tools: OpenAITool[] = body.tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));

  // tool_choice: Anthropic {type:'tool', name} → OpenAI {type:'function', function:{name}}
  const tool_choice: OpenAIToolChoice = {
    type: 'function',
    function: { name: body.tool_choice.name },
  };

  return {
    model,
    messages,
    tools,
    tool_choice,
    max_tokens: body.max_tokens,
  };
}

/** Pull text content out of Anthropic-style content-block arrays. */
function extractTextFromBlocks(content: unknown): string {
  if (!Array.isArray(content)) return String(content ?? '');
  return content
    .map((b) => {
      if (typeof b === 'string') return b;
      if (b && typeof b === 'object' && 'text' in b && typeof (b as { text: unknown }).text === 'string') {
        return (b as { text: string }).text;
      }
      return '';
    })
    .filter((s) => s.length > 0)
    .join('\n\n');
}

/**
 * Parse the OpenAI Chat Completions response: extract the
 * forced-function-call's arguments (a JSON string), validate the shape
 * is a DiagnoseOutput, and return the normalised AiCallResult.
 *
 * `provider` is threaded through so subclasses (AzureOpenAIAdapter) get
 * their own provider tag in the result. Default is 'openai' for the
 * direct OpenAI path.
 */
export function parseOpenAIResponse(
  json: OpenAIResponse,
  expectedToolName: string,
  provider: AiProvider = 'openai',
): AiCallResult {
  if (!json || !Array.isArray(json.choices) || json.choices.length === 0) {
    throw new OpenAIError('unexpected response shape — no `choices` array');
  }
  const choice = json.choices[0]!;
  const toolCalls = choice.message.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    throw new OpenAIError(
      `OpenAI did not call any tool — finish_reason was "${choice.finish_reason}"`,
    );
  }

  const call = toolCalls.find((c) => c.function?.name === expectedToolName);
  if (!call) {
    throw new OpenAIError(
      `OpenAI called a tool but not "${expectedToolName}" — ` +
      `called: ${toolCalls.map((c) => c.function?.name).join(', ')}`,
    );
  }

  let args: unknown;
  try {
    args = JSON.parse(call.function.arguments);
  } catch (err) {
    throw new OpenAIError(
      `tool arguments are not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!isValidDiagnoseOutput(args)) {
    throw new OpenAIError('tool arguments are missing required DiagnoseOutput fields');
  }

  const usage = json.usage;
  return {
    output: args as DiagnoseOutput,
    usage: {
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
      // OpenAI doesn't separately charge for cache writes — report 0.
      cacheCreationTokens: 0,
    },
    model: json.model,
    messageId: json.id,
    provider,
  };
}

async function safeReadError(
  response: Response,
): Promise<{ message: string; errorType?: string }> {
  try {
    const body = (await response.json()) as OpenAIErrorEnvelope | Record<string, unknown>;
    if (body && typeof body === 'object' && 'error' in body) {
      const env = body as OpenAIErrorEnvelope;
      return {
        message: env.error?.message ?? '',
        ...(env.error?.type !== undefined ? { errorType: env.error.type } : {}),
      };
    }
    return { message: JSON.stringify(body) };
  } catch {
    return { message: response.statusText };
  }
}

/** Parse Retry-After header (seconds or HTTP-date). */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const asInt = Number(trimmed);
  if (Number.isFinite(asInt) && asInt >= 0) return Math.floor(asInt * 1000);
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    const delta = asDate - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Chat helpers (shared by OpenAI / Azure / Copilot via inheritance) ────

type OpenAIChatContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >;

interface OpenAIChatRequestBody {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: OpenAIChatContent;
  }>;
  max_tokens: number;
}

interface OpenAIChatResponse {
  id: string;
  model: string;
  choices: Array<{
    message: { role: 'assistant'; content: string | null };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export function buildOpenAIChatBody(input: AiChatInput, defaultModel: string): OpenAIChatRequestBody {
  const model = input.model ?? defaultModel ?? DEFAULT_CHAT_MODEL;
  const maxTokens = input.maxTokens ?? 4096;
  const messages: OpenAIChatRequestBody['messages'] = [];
  if (input.systemPrompt.length > 0) {
    messages.push({ role: 'system', content: input.systemPrompt });
  }
  for (const m of input.messages) {
    if (m.images && m.images.length > 0) {
      const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [];
      for (const dataUrl of m.images) {
        parts.push({ type: 'image_url', image_url: { url: dataUrl } });
      }
      parts.push({ type: 'text', text: m.content });
      messages.push({ role: m.role, content: parts });
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }
  return { model, messages, max_tokens: maxTokens };
}

export function parseOpenAIChatResponse(
  json: OpenAIChatResponse,
  provider: AiProvider = 'openai',
): AiChatResult {
  const choice = json.choices?.[0];
  const text = choice?.message?.content ?? '';
  const usage = json.usage;
  return {
    text,
    usage: {
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
      cacheCreationTokens: 0,
    },
    model: json.model,
    messageId: json.id,
    provider,
  };
}
