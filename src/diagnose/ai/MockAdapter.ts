/**
 * src/diagnose/ai/MockAdapter.ts — deterministic test adapter.
 *
 * Implements the `AiClient` interface but serves canned responses from a
 * fixture file (or an inline object passed in tests). Used to exercise the
 * full AI flow — `pgwen new`, `pgwen diagnose`, `@pgwen/fix` — without a
 * real API key and without making any network call.
 *
 * Opt-in only:
 *   - `--provider mock` on the CLI, or
 *   - `PGWEN_AI_PROVIDER=mock` env var,
 *   - plus `PGWEN_AI_MOCK_FIXTURES=<path>` for the fixture file
 *   - OR an inline `{ fixtures: <object> }` passed in tests.
 *
 * Mock is NOT part of the `AiProvider` production enum — it's gated as an
 * escape hatch in `selectAdapter.ts` before the production resolver runs,
 * so production code paths that switch on provider see only real values.
 *
 * Each fixture entry can declare which real provider it impersonates
 * (defaults to "claude"), so downstream branches keyed on `result.provider`
 * still exercise their real-provider code.
 *
 * Matching strategy (in order):
 *   1. Explicit `matchOn` on a fixture entry (substring match against the
 *      relevant input). First entry whose `matchOn` is satisfied wins.
 *   2. Sequential fallback — entries without `matchOn` are consumed in
 *      order, one per unmatched call.
 *   3. `defaultCall` / `defaultChat` — used when nothing else matches.
 *   4. Throw — clear error so test failures surface fixture gaps loudly.
 */

import * as fs from 'fs';
import type { PromptRequestBody } from '../Prompt';
import type {
  AiCallResult,
  AiChatInput,
  AiChatResult,
  AiClient,
  AiProvider,
  AiUsage,
} from './types';
import type { DiagnoseOutput } from '../types';

// ─── Fixture types ─────────────────────────────────────────────────────────

export interface MockCallFixtureEntry {
  /**
   * Optional content match. When set, this entry is only chosen for a
   * call whose prompt string contains the given substring (case-sensitive
   * by default; pass `caseInsensitive=true` to relax).
   *
   * The "prompt string" used for matching is the JSON-serialised
   * `PromptRequestBody` — covers both system prompt and message turns.
   */
  matchOn?: {
    containsInPrompt?: string;
    caseInsensitive?: boolean;
  };
  /**
   * The mocked response. The full `AiCallResult` shape is supported but
   * `usage`, `model`, `messageId`, `provider` are optional — defaults
   * are filled in (zero usage, "mock-claude-sonnet-4-6", undefined id,
   * "claude" provider).
   */
  response: {
    output: DiagnoseOutput;
    usage?: Partial<AiUsage>;
    model?: string;
    messageId?: string;
    provider?: AiProvider;
  };
}

export interface MockChatFixtureEntry {
  matchOn?: {
    containsInLastUserMessage?: string;
    containsInSystemPrompt?: string;
    caseInsensitive?: boolean;
  };
  response: {
    text: string;
    usage?: Partial<AiUsage>;
    model?: string;
    messageId?: string;
    provider?: AiProvider;
  };
}

export interface MockFixtures {
  calls?: MockCallFixtureEntry[];
  chats?: MockChatFixtureEntry[];
  defaultCall?: MockCallFixtureEntry['response'];
  defaultChat?: MockChatFixtureEntry['response'];
}

export interface MockAdapterOptions {
  /** Inline fixtures — preferred in unit tests. */
  fixtures?: MockFixtures;
  /** Path to a fixture JSON file — used by CLI / integration tests. */
  fixturesPath?: string;
  /**
   * Default provider impersonated when a fixture entry doesn't set its
   * own. Defaults to "claude" — matches the pgwen historical default.
   */
  impersonateProvider?: AiProvider;
}

// ─── Adapter ───────────────────────────────────────────────────────────────

export class MockAdapter implements AiClient {
  readonly provider: AiProvider;
  private readonly fixtures: MockFixtures;
  /** Tracks which sequential (matchOn-less) entries have been used. */
  private readonly callCursor: Set<number> = new Set();
  private readonly chatCursor: Set<number> = new Set();

  constructor(opts: MockAdapterOptions = {}) {
    this.provider = opts.impersonateProvider ?? 'claude';
    this.fixtures = loadFixtures(opts);
  }

  async call(body: PromptRequestBody): Promise<AiCallResult> {
    const promptString = JSON.stringify(body);
    const entries = this.fixtures.calls ?? [];

    // 1. Try content match
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (!entry.matchOn) continue;
      if (matchesCall(entry.matchOn, promptString)) {
        return finaliseCallResponse(entry.response, this.provider);
      }
    }

    // 2. Sequential fallback — pick the next entry that has NO matchOn
    //    and hasn't been used yet.
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (entry.matchOn) continue;
      if (this.callCursor.has(i)) continue;
      this.callCursor.add(i);
      return finaliseCallResponse(entry.response, this.provider);
    }

    // 3. Default
    if (this.fixtures.defaultCall) {
      return finaliseCallResponse(this.fixtures.defaultCall, this.provider);
    }

    // 4. Throw — fixtures must cover every call or the test fails loudly.
    throw new Error(
      `MockAdapter.call(): no fixture matched the request and no defaultCall was set. ` +
      `Provide a fixture entry with matching matchOn.containsInPrompt, an additional ` +
      `sequential entry, or a defaultCall fallback.`,
    );
  }

  async chat(input: AiChatInput): Promise<AiChatResult> {
    const lastUser = lastUserMessage(input);
    const entries = this.fixtures.chats ?? [];

    // 1. Content match
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (!entry.matchOn) continue;
      if (matchesChat(entry.matchOn, input.systemPrompt, lastUser)) {
        return finaliseChatResponse(entry.response, this.provider);
      }
    }

    // 2. Sequential
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (entry.matchOn) continue;
      if (this.chatCursor.has(i)) continue;
      this.chatCursor.add(i);
      return finaliseChatResponse(entry.response, this.provider);
    }

    // 3. Default
    if (this.fixtures.defaultChat) {
      return finaliseChatResponse(this.fixtures.defaultChat, this.provider);
    }

    // 4. Throw
    throw new Error(
      `MockAdapter.chat(): no fixture matched the request and no defaultChat was set. ` +
      `Provide a fixture entry with matching matchOn.containsInLastUserMessage / ` +
      `containsInSystemPrompt, an additional sequential entry, or a defaultChat fallback.`,
    );
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function loadFixtures(opts: MockAdapterOptions): MockFixtures {
  if (opts.fixtures) return opts.fixtures;
  const path = opts.fixturesPath ?? process.env.PGWEN_AI_MOCK_FIXTURES;
  if (!path) {
    throw new Error(
      `MockAdapter requires fixtures: pass { fixtures } inline, set ` +
      `{ fixturesPath }, or export PGWEN_AI_MOCK_FIXTURES=<file.json>.`,
    );
  }
  if (!fs.existsSync(path)) {
    throw new Error(`MockAdapter: fixture file not found at "${path}".`);
  }
  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf-8');
  } catch (e) {
    throw new Error(`MockAdapter: failed to read fixture file "${path}": ${(e as Error).message}`);
  }
  try {
    return JSON.parse(raw) as MockFixtures;
  } catch (e) {
    throw new Error(`MockAdapter: fixture file "${path}" is not valid JSON: ${(e as Error).message}`);
  }
}

function matchesCall(
  matchOn: NonNullable<MockCallFixtureEntry['matchOn']>,
  promptString: string,
): boolean {
  if (matchOn.containsInPrompt === undefined) return false;
  const haystack = matchOn.caseInsensitive ? promptString.toLowerCase() : promptString;
  const needle = matchOn.caseInsensitive
    ? matchOn.containsInPrompt.toLowerCase()
    : matchOn.containsInPrompt;
  return haystack.includes(needle);
}

function matchesChat(
  matchOn: NonNullable<MockChatFixtureEntry['matchOn']>,
  systemPrompt: string,
  lastUser: string,
): boolean {
  const ci = !!matchOn.caseInsensitive;
  if (matchOn.containsInLastUserMessage !== undefined) {
    const hay = ci ? lastUser.toLowerCase() : lastUser;
    const ndl = ci ? matchOn.containsInLastUserMessage.toLowerCase() : matchOn.containsInLastUserMessage;
    if (!hay.includes(ndl)) return false;
  }
  if (matchOn.containsInSystemPrompt !== undefined) {
    const hay = ci ? systemPrompt.toLowerCase() : systemPrompt;
    const ndl = ci ? matchOn.containsInSystemPrompt.toLowerCase() : matchOn.containsInSystemPrompt;
    if (!hay.includes(ndl)) return false;
  }
  // At least one constraint must be present; if neither set, treat as no-match.
  return (
    matchOn.containsInLastUserMessage !== undefined ||
    matchOn.containsInSystemPrompt !== undefined
  );
}

function lastUserMessage(input: AiChatInput): string {
  for (let i = input.messages.length - 1; i >= 0; i--) {
    const m = input.messages[i]!;
    if (m.role === 'user') return m.content;
  }
  return '';
}

function finaliseCallResponse(
  response: MockCallFixtureEntry['response'],
  defaultProvider: AiProvider,
): AiCallResult {
  return {
    output: response.output,
    usage: zeroUsage(response.usage),
    model: response.model ?? 'claude-sonnet-4-6',
    ...(response.messageId !== undefined ? { messageId: response.messageId } : {}),
    provider: response.provider ?? defaultProvider,
  };
}

function finaliseChatResponse(
  response: MockChatFixtureEntry['response'],
  defaultProvider: AiProvider,
): AiChatResult {
  return {
    text: response.text,
    usage: zeroUsage(response.usage),
    model: response.model ?? 'claude-sonnet-4-6',
    ...(response.messageId !== undefined ? { messageId: response.messageId } : {}),
    provider: response.provider ?? defaultProvider,
  };
}

function zeroUsage(partial?: Partial<AiUsage>): AiUsage {
  return {
    inputTokens: partial?.inputTokens ?? 0,
    outputTokens: partial?.outputTokens ?? 0,
    cachedInputTokens: partial?.cachedInputTokens ?? 0,
    cacheCreationTokens: partial?.cacheCreationTokens ?? 0,
  };
}
