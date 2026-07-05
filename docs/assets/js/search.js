/**
 * pgwen docs — vanilla client-side search.
 *
 * Loads /assets/data/search-index.json (built from page content), then
 * filters entries by token-matching against the query. Results show
 * the section title and snippet, link straight to the page anchor.
 *
 * Zero dependencies. Token match is case-insensitive substring on the
 * concatenated title + body of each indexed item. Ranks by:
 *   1. title-prefix match
 *   2. title-substring match
 *   3. body-substring match
 */

(function () {
  const input = document.getElementById('search-input');
  const resultsBox = document.getElementById('search-results');
  if (!input || !resultsBox) return;

  let index = null;
  let baseUrl = '';

  // Depth relative to /docs/ — NOT to the filesystem root. When the
  // docs are opened via file:// (no web server) `window.location.pathname`
  // includes the entire filesystem path so segment-counting overcounts
  // wildly. Use the body's data-page attribute as the canonical signal:
  // the root index.html sets data-page="introduction"; every other page
  // sits one folder deeper under pages/.
  const pageId = (document.body.getAttribute('data-page') || '').toLowerCase();
  const pathDepth = pageId === 'introduction' ? 0 : 1;
  baseUrl = pathDepth > 0 ? '../'.repeat(pathDepth) : './';

  function loadIndex() {
    if (index) return Promise.resolve(index);
    return fetch(baseUrl + 'assets/data/search-index.json')
      .then((r) => r.json())
      .then((data) => { index = data; return data; })
      .catch(() => { index = []; return []; });
  }

  function rank(entry, q) {
    const title = (entry.title || '').toLowerCase();
    const body = (entry.body || '').toLowerCase();
    if (title.startsWith(q)) return 3;
    if (title.includes(q))   return 2;
    if (body.includes(q))    return 1;
    return 0;
  }

  function render(query) {
    if (!query) {
      resultsBox.classList.remove('open');
      resultsBox.innerHTML = '';
      return;
    }
    const q = query.toLowerCase();
    const scored = (index || [])
      .map((e) => ({ entry: e, score: rank(e, q) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);

    if (scored.length === 0) {
      resultsBox.innerHTML = '<div class="empty">No matches for "' + escapeHtml(query) + '"</div>';
      resultsBox.classList.add('open');
      return;
    }

    resultsBox.innerHTML = scored.map(({ entry }) => {
      const href = baseUrl + entry.url;
      const section = entry.section || 'Docs';
      return `<a class="result" href="${escapeAttr(href)}">
        <span class="result-section">${escapeHtml(section)}</span>
        <span class="result-title">${highlight(entry.title, q)}</span>
      </a>`;
    }).join('');
    resultsBox.classList.add('open');
  }

  function highlight(text, q) {
    const t = String(text || '');
    const i = t.toLowerCase().indexOf(q);
    if (i < 0) return escapeHtml(t);
    return escapeHtml(t.slice(0, i))
      + '<mark>' + escapeHtml(t.slice(i, i + q.length)) + '</mark>'
      + escapeHtml(t.slice(i + q.length));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  input.addEventListener('focus', loadIndex);
  input.addEventListener('input', (e) => {
    loadIndex().then(() => render(e.target.value.trim()));
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; render(''); input.blur(); }
  });
  // Click-away closes results
  document.addEventListener('click', (e) => {
    if (!resultsBox.contains(e.target) && e.target !== input) {
      resultsBox.classList.remove('open');
    }
  });
})();
