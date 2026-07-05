/**
 * pgwen docs — shared layout injector.
 *
 * Each page carries a <body data-page="<id>"> attribute and provides an
 * empty <aside class="sidebar"></aside> placeholder. This script renders the
 * sidebar from a single source so the ToC stays consistent across pages.
 * The active link is determined by the data-page attribute.
 *
 * Relative paths are resolved from the page's depth (pages at root use
 * `./`, pages one folder deep use `../`, etc.).
 */

(function () {
  const SECTIONS = [
    {
      title: 'Get Started',
      items: [
        { id: 'introduction', href: 'index.html',            label: 'Introduction' },
        { id: 'installation', href: 'pages/installation.html', label: 'Installation' },
        { id: 'first-project',    href: 'pages/first-project.html',   label: 'Your first project' },
        { id: 'repl',         href: 'pages/repl.html',        label: 'Running the REPL' },
      ],
    },
    {
      title: 'Reference',
      items: [
        { id: 'cli',          href: 'pages/cli.html',          label: 'CLI' },
        { id: 'dsl',          href: 'pages/dsl.html',          label: 'DSL' },
        { id: 'settings',     href: 'pages/settings.html',     label: 'Settings' },
        { id: 'annotations',  href: 'pages/annotations.html',  label: 'Annotations' },
        { id: 'reports',      href: 'pages/reports.html',      label: 'Reports' },
      ],
    },
    {
      title: 'Guides',
      items: [
        { id: 'authoring',    href: 'pages/authoring.html',    label: 'Authoring features' },
        { id: 'data-driven',  href: 'pages/data-driven.html',  label: 'Data-driven runs' },
        { id: 'profiles',     href: 'pages/profiles.html',     label: 'Configuration profiles' },
        { id: 'tags',         href: 'pages/tags.html',         label: 'Tags & filtering' },
        { id: 'debugging',    href: 'pages/debugging.html',    label: 'Debugging' },
        { id: 'new-project',      href: 'pages/new-project.html',      label: 'pgwen new — project scaffolder' },
      ],
    },
    {
      title: 'Diagnose & AI',
      items: [
        { id: 'diagnose',     href: 'pages/diagnose.html',     label: 'pgwen diagnose CLI' },
        { id: 'ai-pipeline',  href: 'pages/ai-pipeline.html',  label: 'AI pipeline architecture' },
      ],
    },
    {
      title: 'Help',
      items: [
        { id: 'faq',          href: 'pages/faq.html',          label: 'FAQ' },
      ],
    },
  ];

  function pageDepth() {
    // Depth relative to /docs/ — NOT to the filesystem root. When the
    // docs are opened via file:// (no web server) `window.location.pathname`
    // includes the whole filesystem path so segment-counting overcounts
    // wildly. Use the `data-page` attribute instead: the root
    // `index.html` is always `introduction`; every other page lives one
    // folder deeper, under `pages/`.
    const pageId = (document.body.getAttribute('data-page') || '').toLowerCase();
    return pageId === 'introduction' ? 0 : 1;
  }

  function rel(href) {
    const depth = pageDepth();
    return depth > 0 ? '../'.repeat(depth) + href : './' + href;
  }

  function renderSidebar(activeId) {
    const out = [];
    for (const section of SECTIONS) {
      out.push(`<h3>${escapeHtml(section.title)}</h3><ul>`);
      for (const item of section.items) {
        const cls = item.id === activeId ? ' class="active"' : '';
        out.push(`<li><a href="${escapeAttr(rel(item.href))}"${cls}>${escapeHtml(item.label)}</a></li>`);
      }
      out.push('</ul>');
    }
    return out.join('');
  }

  function renderTopNav(activeId) {
    // Top nav: Docs (intro), DSL, Settings, plus stub links matching the pgwen-style layout
    const linkClass = (id) => id === activeId ? ' class="active"' : '';
    return `
      <a href="${escapeAttr(rel('index.html'))}"${linkClass('introduction')}>Docs</a>
      <a href="${escapeAttr(rel('pages/dsl.html'))}"${linkClass('dsl')}>DSL</a>
      <a href="${escapeAttr(rel('pages/settings.html'))}"${linkClass('settings')}>Settings</a>
      <a href="${escapeAttr(rel('pages/cli.html'))}"${linkClass('cli')}>CLI</a>
    `;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  function init() {
    const activeId = document.body.getAttribute('data-page') || '';
    const sidebar = document.querySelector('aside.sidebar');
    if (sidebar) sidebar.innerHTML = renderSidebar(activeId);

    const topNav = document.querySelector('nav.site-nav');
    if (topNav) topNav.innerHTML = renderTopNav(activeId);

    // Set the logo href to root
    const logo = document.querySelector('.site-logo');
    if (logo) logo.setAttribute('href', rel('index.html'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
