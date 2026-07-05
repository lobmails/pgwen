/**
 * HtmlReport.ts — renders the standalone `<reportsDir>/index.html` page for
 * `@pgwen/fix`. Self-contained: inline CSS, no JS, no external assets.
 *
 * Visual language matches `@pgwen/core`'s HtmlReporter Bootstrap-3 palette
 * (pgwen blue #1f23ae, success/danger/info/warning Bootstrap tints, badge
 * + panel + bg-* class names). Side-by-side with the main report, an
 * operator should recognise it as the same family.
 *
 * No dependency on the core package — the rendered HTML is identical
 * whether produced by this file or hand-rolled.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Suggestion } from './types';

export interface RenderHtmlInputs {
  suggestions: Suggestion[];
  /** Version string from package.json. Rendered in the header. */
  version: string;
  /** ISO 8601 UTC. Rendered in the header. */
  generatedAt: string;
}

const HEAD_CSS = `
  body { margin: 20px 40px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: #333333; }
  div { word-wrap: break-word; }
  header { display: flex; align-items: baseline; gap: 12px; padding-bottom: 8px; border-bottom: 1px solid #d9d9d9; margin-bottom: 16px; }
  header .brand { font-size: 24px; font-weight: bold; color: #1f23ae; }
  header .subtitle { color: gray; font-size: 14px; }
  header .meta { margin-left: auto; color: gray; font-size: 12px; }
  .summary { display: flex; gap: 12px; margin-bottom: 16px; }
  .summary .stat { padding: 8px 12px; background-color: #f5f5f5; border: 1px solid #d9d9d9; border-radius: 4px; font-size: 13px; }
  .summary .stat strong { color: #1f23ae; }
  .panel { margin-bottom: 16px; border: 1px solid #d9d9d9; border-radius: 4px; overflow: hidden; }
  .panel-heading { padding: 10px 12px; background-color: #f5f5f5; border-bottom: 1px solid #d9d9d9; }
  .panel-heading.danger  { background-color: #f2dede; border-color: #e2b6b6; color: #a94442; }
  .panel-heading.warning { background-color: #fcf8e3; border-color: #f5e8a3; color: #8a6d3b; }
  .panel-heading.info    { background-color: #d9edf7; border-color: #abd7ed; color: #31708f; }
  .panel-heading .title { font-weight: bold; }
  .panel-heading .path { color: gray; font-size: 12px; margin-left: 8px; }
  .panel-body { padding: 12px; }
  .badge { display: inline-block; padding: 2px 6px; font-size: 11px; color: #ffffff; border-radius: 3px; margin-right: 4px; vertical-align: middle; }
  .badge.badge-danger  { background-color: #d9534f; }
  .badge.badge-warning { background-color: #f0ad4e; }
  .badge.badge-info    { background-color: #5bc0de; }
  .badge.badge-success { background-color: #5cb85c; }
  .badge.badge-default { background-color: #777777; }
  .badge.badge-pgwen   { background-color: #1f23ae; }
  dl.kv { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; font-size: 13px; }
  dl.kv dt { color: gray; }
  dl.kv dd { margin: 0; color: #333333; }
  pre.diff { background-color: #f5f5f5; border: 1px solid #d9d9d9; border-radius: 4px; padding: 10px; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size: 12px; line-height: 1.4; overflow-x: auto; white-space: pre; }
  pre.diff .add { background-color: #dff0d8; color: #3c763d; display: block; }
  pre.diff .del { background-color: #f2dede; color: #a94442; display: block; }
  pre.diff .hunk { color: #31708f; display: block; }
  pre.diff .meta { color: gray; display: block; }
  .section-title { font-weight: bold; margin-top: 12px; margin-bottom: 4px; color: #333333; }
  .rationale { font-size: 13px; line-height: 1.5; color: #555555; }
  .validation { font-size: 12px; color: gray; }
  .validation .ok { color: #3c763d; }
  .validation .bad { color: #a94442; }
  .apply pre { background-color: #333333; color: #f5f5f5; padding: 8px 10px; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size: 12px; overflow-x: auto; }
  .empty { padding: 40px; text-align: center; color: gray; background-color: #f5f5f5; border-radius: 4px; }
  .instances { margin: 8px 0 0; padding: 8px 12px; background-color: #f5f5f5; border: 1px solid #d9d9d9; border-radius: 4px; font-size: 12px; }
  .instances summary { cursor: pointer; color: #1f23ae; font-weight: bold; }
  .instances ul { margin: 6px 0 0; padding-left: 20px; }
  .instances li { color: #555555; margin: 2px 0; }
  footer { margin-top: 24px; padding-top: 8px; border-top: 1px solid #d9d9d9; color: gray; font-size: 11px; }
`;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function badgeForConfidence(c: Suggestion['confidence']): string {
  const cls =
    c === 'high' ? 'badge-success' : c === 'medium' ? 'badge-warning' : 'badge-info';
  return `<span class="badge ${cls}">${escapeHtml(c)}</span>`;
}

function panelHeadingClass(c: Suggestion['confidence']): string {
  return c === 'high' ? 'danger' : c === 'medium' ? 'warning' : 'info';
}

function renderDiff(patch: string): string {
  const lines = patch.split('\n');
  const parts: string[] = [];
  for (const line of lines) {
    if (line.startsWith('---') || line.startsWith('+++')) {
      parts.push(`<span class="meta">${escapeHtml(line)}</span>`);
    } else if (line.startsWith('@@')) {
      parts.push(`<span class="hunk">${escapeHtml(line)}</span>`);
    } else if (line.startsWith('+')) {
      parts.push(`<span class="add">${escapeHtml(line)}</span>`);
    } else if (line.startsWith('-')) {
      parts.push(`<span class="del">${escapeHtml(line)}</span>`);
    } else {
      parts.push(escapeHtml(line));
    }
  }
  return parts.join('\n');
}

function renderInstancesBlock(s: Suggestion): string {
  if (!s.affected_instances || s.affected_instances.length <= 1) return '';
  const total = s.affected_instances.length;
  const others = s.affected_instances.slice(1);
  const items = others
    .map(
      (i) =>
        `<li><code>${escapeHtml(i.feature_file)}</code> — <em>${escapeHtml(i.scenario_name)}</em></li>`,
    )
    .join('\n');
  return `
        <details class="instances">
          <summary>Pattern affects ${total} instances — applying this one patch resolves all of them</summary>
          <ul>${items}</ul>
        </details>`;
}

function renderCard(s: Suggestion): string {
  const headingClass = panelHeadingClass(s.confidence);
  const validationItems = s.validation.ok
    ? '<span class="ok">all checks passed</span>'
    : s.validation.violations
        .map((v) => `<span class="bad">${escapeHtml(v)}</span>`)
        .join(' &middot; ');
  const instancesCount = s.affected_instances?.length ?? 1;
  const patternChip =
    instancesCount > 1
      ? `<span class="badge badge-info" title="this one fix resolves N instances">${instancesCount}× pattern</span>`
      : '';

  return `
    <div class="panel">
      <div class="panel-heading ${headingClass}">
        <span class="badge badge-pgwen">${escapeHtml(s.category)}</span>
        ${badgeForConfidence(s.confidence)}
        ${patternChip}
        <span class="title">${escapeHtml(s.scenario_name)}</span>
        <span class="path">${escapeHtml(s.feature_file)}</span>
      </div>
      <div class="panel-body">
        <dl class="kv">
          <dt>Step</dt><dd>${escapeHtml(s.step_text)}</dd>
          <dt>Binding</dt><dd>${escapeHtml(s.binding_name)}</dd>
          <dt>Location</dt><dd>${escapeHtml(s.file)}:${s.line}</dd>
          <dt>Created</dt><dd>${escapeHtml(s.createdAt)}</dd>
        </dl>
${renderInstancesBlock(s)}
        <div class="section-title">Proposed change</div>
        <pre class="diff">${renderDiff(s.patch)}</pre>

        <div class="section-title">Why</div>
        <div class="rationale">${escapeHtml(s.rationale)}</div>

        <div class="section-title">Validation</div>
        <div class="validation">${validationItems}</div>

        <div class="section-title">Apply</div>
        <div class="apply"><pre>patch -p1 &lt; ${escapeHtml('suggestions/' + s.id + '.patch')}</pre></div>
      </div>
    </div>
  `;
}

/**
 * Render the page HTML. Pure — caller decides where to write.
 */
export function renderHtmlReport(inputs: RenderHtmlInputs): string {
  const total = inputs.suggestions.length;
  const counts = inputs.suggestions.reduce(
    (acc, s) => {
      acc[s.confidence] = (acc[s.confidence] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const body =
    total === 0
      ? `<div class="empty">No fix suggestions in this report. Run <code>pgwen-fix</code> against a recent diagnose output to populate this page.</div>`
      : inputs.suggestions.map(renderCard).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>pgwen-fix · suggestions</title>
  <style>${HEAD_CSS}</style>
</head>
<body>
  <header>
    <span class="brand">pgwen-fix</span>
    <span class="subtitle">suggested locator fixes</span>
    <span class="meta">v${escapeHtml(inputs.version)} &middot; generated ${escapeHtml(inputs.generatedAt)}</span>
  </header>

  <div class="summary">
    <div class="stat"><strong>${total}</strong> suggestion${total === 1 ? '' : 's'}</div>
    <div class="stat"><strong>${counts['high'] ?? 0}</strong> high</div>
    <div class="stat"><strong>${counts['medium'] ?? 0}</strong> medium</div>
  </div>

  ${body}

  <footer>
    pgwen-fix runs in suggest-only mode — no files or branches are modified.
    Review each suggestion and apply with <code>patch -p1</code> if accepted.
  </footer>
</body>
</html>
`;
}

/**
 * Convenience wrapper: render + write to `<reportsDir>/index.html`.
 */
export function writeHtmlReport(reportsDir: string, inputs: RenderHtmlInputs): string {
  fs.mkdirSync(reportsDir, { recursive: true });
  const target = path.join(reportsDir, 'index.html');
  fs.writeFileSync(target, renderHtmlReport(inputs), 'utf8');
  return target;
}
