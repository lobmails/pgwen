/**
 * src/diagnose/ai/validator.ts — shared DiagnoseOutput validator.
 *
 * Each adapter parses its provider's tool-call payload back into a
 * `DiagnoseOutput`. The shape check is identical regardless of provider —
 * factored out here so we don't duplicate the rule across Claude /
 * OpenAI / Azure OpenAI / Copilot. Liberal on minor deviations, strict
 * on missing required top-level keys; the patch applier enforces the
 * §12 hard rules (machine_proposal null unless locator_drift+high).
 */

import type { DiagnoseOutput } from '../types';

export function isValidDiagnoseOutput(input: unknown): input is DiagnoseOutput {
  if (!input || typeof input !== 'object') return false;
  const o = input as Record<string, unknown>;
  const required = [
    'category',
    'confidence',
    'human_explanation',
    'evidence',
    'alternatives_considered',
    'files_likely_involved',
    'escalation_signals',
    'machine_proposal',
    'auto_fix_safe',
  ];
  for (const key of required) {
    if (!(key in o)) return false;
  }
  if (typeof o['category'] !== 'string') return false;
  if (typeof o['confidence'] !== 'string') return false;
  if (typeof o['human_explanation'] !== 'string') return false;
  if (typeof o['auto_fix_safe'] !== 'boolean') return false;
  if (!Array.isArray(o['evidence'])) return false;
  if (!Array.isArray(o['alternatives_considered'])) return false;
  if (!Array.isArray(o['files_likely_involved'])) return false;
  return true;
}
