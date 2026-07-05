# AI Mock Fixtures

Canned AI responses for use with `MockAdapter` (`src/diagnose/ai/MockAdapter.ts`).
Lets you exercise `pgwen diagnose`, `pgwen new`, and `@pgwen/fix` end-to-end with
no API key and no network call.

## Files

| File | Purpose | Trigger |
|---|---|---|
| `locator-drift.json` | Locator attribute shifted; element present; safe auto-fix proposal | prompt contains `LOCATOR_NOT_FOUND` |
| `app-regression.json` | App contract changed (page rerouted, element vanished); no proposal | prompt contains `NAVIGATION_FAILURE` |
| `timing.json` | Async render race; suggests `@Delay` / `@Timeout`, not a rebind | prompt contains `TIMEOUT` |
| `env.json` | Environment-level failure (auth dropped, token expired) | prompt contains `AUTH_FAILURE` |
| `test-bug.json` | Test logic wrong (e.g. wrong expected casing) | prompt contains `ASSERTION_FAILED` |
| `unknown.json` | Insufficient signal; escalates to human | falls through; also serves as `defaultCall` |
| `new-project-interview.json` | Multi-turn `pgwen new` interview. **Each chat() text is a JSON-encoded turn response** of shape `{type:'question'\|'blueprint'\|'ready', ...}` per `src/cli/NewProject.ts:402 parseTurnResponse`. The fixture covers the canonical happy path: question → blueprint → ready (with full files map). | matches user-message substrings turn-by-turn |
| `all.json` | Combined router covering all 6 categories + a default | use this for end-to-end tests that exercise multiple paths |

## Usage

### Inline (unit tests)

```ts
import { selectAdapter } from 'pgwen/src/diagnose/ai/selectAdapter';
import fixtures from 'pgwen/fixtures/ai-mock/locator-drift.json';

const adapter = selectAdapter({
  provider: 'mock',
  apiKey: 'unused',
  mock: { fixtures },
});
```

### File path (CLI / integration tests)

```bash
export PGWEN_AI_PROVIDER=mock
export PGWEN_AI_MOCK_FIXTURES=./fixtures/ai-mock/all.json
pgwen diagnose --input results.json
```

Or inline on the CLI:

```bash
pgwen diagnose --provider mock --input results.json
# then point PGWEN_AI_MOCK_FIXTURES at the file
```

## Schema

See `src/diagnose/ai/MockAdapter.ts` (`MockFixtures` interface) for the full
type. Top-level keys:

- `calls[]` — fixtures for `AiClient.call()` (forced-tool-call mode used by diagnose)
- `chats[]` — fixtures for `AiClient.chat()` (free-form mode used by `pgwen new`)
- `defaultCall` / `defaultChat` — final fallback when no matchOn / sequential entry matches
- `_meta` — informational only; ignored by the adapter

Each fixture entry has an optional `matchOn`:

- For `calls[]`: `{ containsInPrompt: string, caseInsensitive?: boolean }`
- For `chats[]`: `{ containsInLastUserMessage?: string, containsInSystemPrompt?: string, caseInsensitive?: boolean }`

Without `matchOn`, entries are consumed sequentially (one per unmatched call).

## Provider impersonation

Each `response` can set its own `provider` (defaults to `claude`). If your
downstream code branches on `result.provider`, mock the relevant branch:

```jsonc
{
  "response": {
    "output": { ... },
    "provider": "azure-openai"  // exercises Azure-specific path
  }
}
```

## Hand-editing tips

- Indent with two spaces, double-quoted JSON.
- The `_meta` field is ignored by the adapter — use it for human comments.
- `DiagnoseOutput.machine_proposal` MUST be `null` unless `category=locator_drift`
  AND `confidence=high` AND `auto_fix_safe=true`. The applier rejects otherwise.
- Inside `human_explanation`, escape any inner double quotes with `\"`.
