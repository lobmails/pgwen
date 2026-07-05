/**
 * src/diagnose/ai/types.ts — provider-agnostic AI client contract.
 *
 * The diagnose pipeline (and pgwen:new in phase G) talks to AI providers
 * through this `AiClient` interface, not directly to a provider's SDK or
 * fetch wrapper. Each provider gets one adapter that wraps its native
 * wire format behind this surface. The factory in `selectAdapter.ts`
 * returns the right adapter based on `pgwen.diagnose.ai.provider`
 * (config) overridden by the `--provider` CLI flag when present.
 *
 * Phase A scope: type + interface only. `ClaudeAdapter` is the only
 * concrete impl. Phase B adds OpenAI, C adds Azure OpenAI, D adds
 * GitHub Copilot. The interface stays stable across phases.
 */

import type { PromptRequestBody } from '../Prompt';
import type { ClaudeCallResult, ClaudeCallUsage } from '../ClaudeClient';

/** Provider identifier. New providers must extend this union exactly. */
export type AiProvider = 'claude' | 'openai' | 'azure-openai' | 'copilot';

/** Aggregated usage stats, normalised across providers. */
export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from a provider-side prompt cache (Claude / OpenAI). */
  cachedInputTokens: number;
  /** Tokens written to the prompt cache (Claude only — others report 0). */
  cacheCreationTokens: number;
}

/** Normalised AI response. Identical shape across providers. */
export interface AiCallResult {
  /**
   * Parsed structured output — the DiagnoseOutput from the forced tool
   * call. Each adapter is responsible for translating the provider's
   * tool-result shape into this typed object.
   */
  output: import('../types').DiagnoseOutput;
  usage: AiUsage;
  /** Provider-reported model identifier (e.g. claude-sonnet-4-6, gpt-4o-2024-08-06). */
  model: string;
  /** Provider-specific id for telemetry — undefined when the provider doesn't supply one. */
  messageId?: string;
  /** Which adapter served this call. */
  provider: AiProvider;
}

/**
 * Provider-agnostic client interface. Two methods:
 *
 *   - `call()` — forced-tool-call mode used by `pgwen diagnose`. Takes an
 *     Anthropic-shaped `PromptRequestBody`; each adapter translates to
 *     its provider's wire format. Returns a structured `DiagnoseOutput`.
 *
 *   - `chat()` — free-form conversational mode used by `pgwen:new`. Takes
 *     a portable `AiChatInput` (system prompt + messages + optional
 *     images), returns the assistant's plain text. Adapters share auth /
 *     retry / URL machinery but each builds its own request body.
 */
export interface AiClient {
  readonly provider: AiProvider;
  call(body: PromptRequestBody): Promise<AiCallResult>;
  chat(input: AiChatInput): Promise<AiChatResult>;
}

/** One turn in a chat conversation. */
export interface AiChatMessage {
  role: 'user' | 'assistant';
  /** Plain text content. */
  content: string;
  /**
   * Optional base64 data URLs (`data:image/png;base64,...`) attached to
   * this message. The typical pattern: the FIRST user message carries
   * the screenshots that came with the original requirements; follow-up
   * Q&A turns carry text only. Providers without vision support drop
   * the images silently.
   */
  images?: string[];
}

export interface AiChatInput {
  /** System prompt prepended to every turn. */
  systemPrompt: string;
  /** Conversation turns in chronological order. Last message must be `user`. */
  messages: AiChatMessage[];
  /**
   * Optional model override. Each provider has its own default
   * (Anthropic: claude-sonnet-4-6, OpenAI: gpt-4o-2024-08-06, etc.).
   */
  model?: string;
  /** Cap on the response. Default 4096. */
  maxTokens?: number;
}

export interface AiChatResult {
  /** Assistant's reply, concatenated from any content blocks the provider returned. */
  text: string;
  usage: AiUsage;
  model: string;
  messageId?: string;
  provider: AiProvider;
}

// ─── Internal helpers shared across adapters ───────────────────────────────

/** Convert a ClaudeCallResult into the provider-agnostic AiCallResult. */
export function fromClaudeResult(result: ClaudeCallResult): AiCallResult {
  return {
    output: result.output,
    usage: usageFromClaude(result.usage),
    model: result.model,
    messageId: result.messageId,
    provider: 'claude',
  };
}

function usageFromClaude(u: ClaudeCallUsage): AiUsage {
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cachedInputTokens: u.cachedInputTokens,
    cacheCreationTokens: u.cacheCreationTokens,
  };
}
