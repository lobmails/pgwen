# pgwen — AI prompt audit

The three AI surfaces ship with locked-down prompt bodies. This doc is
the contract: variables in, response shape out, validator behaviour,
and where the snapshot tests live so prompt edits are reviewed at PR
time, not in production.

The snapshot tests use the shipped `fixtures/ai-mock/` data — every
prompt body produced for the test inputs is byte-comparable against a
committed snapshot file. Any edit that changes wire format trips the
snapshot diff in CI.

---

## 1. `buildPrompt` — diagnose `report_diagnosis`

**File:** `src/diagnose/Prompt.ts:247`

**Purpose:** post-hoc failure analysis. One forced tool call per failure
bundle; Claude must return a structured `DiagnoseOutput`.

### Variables in

| Field | Type | Source | Notes |
|---|---|---|---|
| `bundle` | `DiagnoseInput` | `src/diagnose/types.ts:18` | Failure + locator + DOM excerpt + sibling scenarios + history. JSON-serialised into the user message. |
| `prior` | `FailureClassification \| null` | `src/diagnose/Classifier.ts` | Rule-based classifier verdict. Gates model routing (medium → Haiku, low/null → Sonnet). NOT included in the prompt body — used only for model selection. |
| `opts.model` | `string?` | CLI / caller | Override model routing. |
| `opts.maxTokens` | `number?` | CLI / caller | Default `DEFAULT_MAX_OUTPUT_TOKENS=800`. |
| `opts.systemOverride` | `string?` | Tests | Override the canned system prompt — tests only. |

### Wire body

```
{
  model: "claude-sonnet-4-6" | "claude-haiku-4-5-20251001" | <override>,
  max_tokens: 800 | <override>,
  system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: JSON.stringify(bundle) }],
  tools: [{
    name: "report_diagnosis",
    description: "Report the structured diagnosis ...",
    input_schema: DIAGNOSE_OUTPUT_SCHEMA,
    cache_control: { type: 'ephemeral' },
  }],
  tool_choice: { type: 'tool', name: 'report_diagnosis' },
}
```

### Response schema (`DIAGNOSE_OUTPUT_SCHEMA`)

`src/diagnose/types.ts:77` `DiagnoseOutput`:

| Field | Type | Required | Notes |
|---|---|---|---|
| `category` | `'locator_drift' \| 'app_regression' \| 'timing' \| 'env' \| 'test_bug' \| 'unknown'` | yes | Drives downstream routing. |
| `confidence` | `'high' \| 'medium' \| 'low'` | yes | Auto-apply requires `high`. |
| `human_explanation` | `string` | yes | Always present. Never machine-parsed. |
| `evidence` | `string[]` | yes | Ranked citations Claude used. |
| `alternatives_considered` | `{ option, rejected_because }[]` | yes | Counter-cases. |
| `files_likely_involved` | `{ path, role }[]` | yes | role ∈ locator / feature / app-code / config. |
| `escalation_signals` | object | yes | `prior_pgwen_fix_on_same_line`, `shared_meta_imported_by_multiple_features`, `failure_repeated_in_consecutive_runs`. |
| `machine_proposal` | object \| null | yes | Patch proposal; null unless category=locator_drift AND confidence=high AND no escalation. |
| `auto_fix_safe` | `boolean` | yes | Derived flag. Validators MUST re-check server-side; never trust blindly. |

### Validator behaviour

- `src/diagnose/validator.ts` enforces required fields + enum values + the `machine_proposal === null when not auto_fix_safe` invariant.
- `@pgwen/fix` suggest mode + auto-apply mode BOTH re-derive `auto_fix_safe` from `category + confidence + escalation_signals` and refuse if the field disagrees.

### Snapshot tests

`tests/unit/diagnose/Prompt.snapshot.test.ts` — covers:
- Default opts (no overrides)
- `prior` null vs medium vs low (model routing)
- Custom model + maxTokens
- Bundle with optional fields populated vs absent

---

## 2. `buildSystemPrompt` — `pgwen new` conversation

**File:** `src/cli/NewProjectPrompt.ts:97`

**Purpose:** multi-turn dialog with the project author. Free-form chat —
**not** a forced tool call. Each turn is JSON-encoded with discriminator
`type ∈ {question, blueprint, ready, warning}` per
`parseTurnResponse` (`src/cli/NewProject.ts:402`).

### Variables in

| Field | Type | Source | Notes |
|---|---|---|---|
| `conventions` | `string?` | `ProjectContext` (CLI) | Optional organisation-specific text inlined verbatim. Overrides generic defaults when they overlap. |

### Output

Returns a single `string` — the system prompt. NewProject's `runConversation()` wraps it into an `AiChatInput` with the user turns appended.

### Response schema (`ClaudeTurnResponse` discriminated union)

`src/cli/NewProjectPrompt.ts` — each turn is one of:

| `type` | Shape | Trigger |
|---|---|---|
| `question` | `{ questions: string[], field, help? }` | Need more info from the user. Max 12 questions across whole conversation (hard cap). |
| `blueprint` | `{ summary, folder_structure, selected_capabilities, excluded_capabilities, scripts, sample_files, ci_cd, assumptions, risks, todos }` | Ready to propose a structure for the user to approve. |
| `ready` | `{ summary, files: Record<path, content> }` | Blueprint approved; emit the full file map. |
| `warning` | `{ risk, detail, options }` | Risky decision point — let the user choose. |

### Validator behaviour

`src/cli/NewProject.ts:parseTurnResponse` (~line 402) JSON-parses each text response, asserts the discriminator + required fields per type. Rejection → debug file written to `os.tmpdir()` + thrown.

Hard rules enforced by the surrounding `runConversation()` loop:
- Question cap (12) — past cap, CLI forces a blueprint with TODOs for unknowns.
- Mandatory blueprint gate — `ready` before any `blueprint` is rejected; CLI prompts for blueprint.
- Approval required — user must explicitly say yes before any `ready` payload is honoured.

### Snapshot tests

`tests/unit/cli/NewProjectPrompt.snapshot.test.ts` — covers:
- No conventions
- With short conventions block
- With multi-line conventions

---

## 3. `buildHealPrompt` — runtime heal `propose_locator`

**File:** `src/heal/HealPrompt.ts:70`

**Purpose:** mid-run locator rebind. One forced tool call per failed
binding; Claude proposes one replacement selector.

### Variables in

| Field | Type | Source | Notes |
|---|---|---|---|
| `bundle` | `HealInput` | `src/heal/HealBundle.ts` | Narrower than diagnose — no sibling scenarios, no trace.zip. Just binding info + scrubbed DOM excerpt + optional locator metadata + optional recent diffs. |
| `opts.model` | `string?` | Caller | Override. |
| `opts.maxTokens` | `number?` | Caller | Default `DEFAULT_MAX_OUTPUT_TOKENS=1024`. |
| `opts.targetConfidence` | `'high' \| 'medium' \| 'low'?` | Caller | Drives model routing only — validator independently enforces the confidence floor from `pgwen.heal.confidence.minimum`. |

### Wire body

```
{
  model: "claude-haiku-4-5-20251001" (high) | "claude-sonnet-4-6" (medium/low),
  max_tokens: 1024 | <override>,
  system: [{ type: 'text', text: HEAL_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: JSON.stringify(bundle) }],
  tools: [{
    name: "propose_locator",
    description: "Report a single replacement locator ...",
    input_schema: { selector_type, selector_value, confidence, reasoning, expected_element_tag? },
    cache_control: { type: 'ephemeral' },
  }],
  tool_choice: { type: 'tool', name: 'propose_locator' },
}
```

### Response schema

| Field | Type | Required | Notes |
|---|---|---|---|
| `selector_type` | `'id' \| 'name' \| 'css' \| 'xpath' \| 'text' \| 'js'` | yes | pgwen DSL locator strategies. |
| `selector_value` | `string` | yes | The selector text for the chosen strategy. |
| `confidence` | `'high' \| 'medium' \| 'low'` | yes | Floor enforced by HealValidator. |
| `reasoning` | `string` | yes | ≤500 chars (enforced by tool schema). |
| `expected_element_tag` | `string?` | no | Lowercase tag name — feeds the validator's tag-class sanity check. |

### Validator behaviour

`src/heal/HealValidator.ts:validate()` — three checks, in order:

1. **Identity check.** `proposal.selector_type === original.type AND proposal.selector_value.trim() === original.value.trim()` → reject (`no_change`). Catches Claude returning the failing selector.
2. **Exact-one-match.** Proposed selector must locate exactly ONE element. Zero → `zero_match`. ≥2 → `multi_match`.
3. **Tag-class match.** Located element's tag matches `LocatorMetadata.expected_tag` (preferred) or `proposal.expected_element_tag`. Mismatch → `tag_mismatch`. No-op when neither side declares a tag.

`HealPipeline.attempt()` also enforces a confidence-floor check BEFORE the validator — `proposal.confidence < config.confidence.minimum` → `claude_low_confidence` outcome, no validator call.

### Snapshot tests

`tests/unit/heal/HealPrompt.snapshot.test.ts` — covers:
- Default opts (`targetConfidence` unset → Haiku)
- `targetConfidence = 'medium'` → Sonnet
- `targetConfidence = 'low'` → Sonnet
- Custom model override
- Custom maxTokens
- Bundle with optional fields (`locator_meta`, `recent_diffs`) populated vs absent

---

## Snapshot test maintenance

When intentionally changing a prompt:

1. Edit the prompt template.
2. Run `yarn test --update-snapshots tests/unit/.../{prompt}.snapshot.test.ts`.
3. Review the snapshot diff in the PR description — reviewers see the
   exact wire-format change.
4. Update this audit doc if the change affects variables-in or
   response-out tables.

When the snapshot diff is unintentional:
- Find the upstream edit that triggered it.
- If the edit was meant, regenerate; if not, revert.

The snapshots live next to their tests (`__snapshots__/`).
