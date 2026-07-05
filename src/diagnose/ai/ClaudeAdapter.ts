/**
 * src/diagnose/ai/ClaudeAdapter.ts — Anthropic Claude adapter.
 *
 * Thin wrapper around `ClaudeClient` that exposes the provider-agnostic
 * `AiClient` interface. Behaviour is identical to using `ClaudeClient`
 * directly — this adapter exists so the pipeline can hold a single
 * `AiClient` reference regardless of which provider was selected.
 *
 * Constructor options + retries / timeouts / extra-headers all forwarded
 * to the underlying `ClaudeClient`. New providers (OpenAI, Azure OpenAI,
 * Copilot) get sibling adapters in Phase B / C / D.
 */

import type { PromptRequestBody } from '../Prompt';
import { ClaudeClient, type ClaudeClientOptions } from '../ClaudeClient';
import type { AiCallResult, AiChatInput, AiChatResult, AiClient, AiProvider } from './types';
import { fromClaudeResult } from './types';

const DEFAULT_CHAT_MODEL = 'claude-sonnet-4-6';

export class ClaudeAdapter implements AiClient {
  readonly provider: AiProvider = 'claude';
  private readonly client: ClaudeClient;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly anthropicVersion: string;

  constructor(opts: ClaudeClientOptions) {
    this.client = new ClaudeClient(opts);
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.anthropicVersion = opts.anthropicVersion ?? '2023-06-01';
  }

  async call(body: PromptRequestBody): Promise<AiCallResult> {
    const result = await this.client.call(body);
    return fromClaudeResult(result);
  }

  /**
   * Free-form conversational chat — no forced tool call. Used by
   * `pgwen:new`'s multi-turn dialogue. Goes to /v1/messages with the
   * same auth / headers ClaudeClient uses for the tool-call path.
   *
   * Images attach to the LAST user message as Anthropic-style
   * content blocks (`{type:'image', source:{...base64}}`); text-only
   * messages stay as plain strings for compactness.
   */
  async chat(input: AiChatInput): Promise<AiChatResult> {
    const url = `${this.baseUrl}/v1/messages`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': this.anthropicVersion,
    };
    const body = buildClaudeChatBody(input);
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new Error(`Claude chat HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    const json = (await response.json()) as ClaudeChatResponse;
    return parseClaudeChatResponse(json);
  }
}

// ─── Wire shapes + helpers (exported for tests) ───────────────────────────

interface ClaudeChatRequestBody {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string | Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }>;
  }>;
}

interface ClaudeChatResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<{ type: 'text'; text: string } | { type: string }>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export function buildClaudeChatBody(input: AiChatInput): ClaudeChatRequestBody {
  const model = input.model ?? DEFAULT_CHAT_MODEL;
  const maxTokens = input.maxTokens ?? 4096;
  const messages = input.messages.map((m) => {
    if (m.images && m.images.length > 0) {
      const blocks: NonNullable<ClaudeChatRequestBody['messages'][number]['content']> = [];
      for (const dataUrl of m.images) {
        const parsed = parseDataUrl(dataUrl);
        if (parsed) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: parsed.mediaType, data: parsed.base64 },
          });
        }
      }
      blocks.push({ type: 'text', text: m.content });
      return { role: m.role, content: blocks };
    }
    return { role: m.role, content: m.content };
  });
  return { model, max_tokens: maxTokens, system: input.systemPrompt, messages };
}

export function parseClaudeChatResponse(json: ClaudeChatResponse): AiChatResult {
  const text = json.content
    .filter((b): b is { type: 'text'; text: string } => (b as { type?: string }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('');
  const usage = json.usage ?? { input_tokens: 0, output_tokens: 0 };
  return {
    text,
    usage: {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cachedInputTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    },
    model: json.model,
    messageId: json.id,
    provider: 'claude',
  };
}

/** `data:image/png;base64,iVBOR...` → `{ mediaType, base64 }`. */
function parseDataUrl(url: string): { mediaType: string; base64: string } | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(url);
  if (!m) return null;
  return { mediaType: m[1]!, base64: m[2]! };
}
