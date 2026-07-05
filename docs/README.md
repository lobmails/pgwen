# pgwen docs

Static documentation site for pgwen. Plain HTML/CSS/JS — no build step, zero
runtime dependencies. Layout mirrors gweninterpreter.org.

## Run locally

```sh
yarn docs:serve
# or, equivalently
cd docs && python3 -m http.server 8080
```

Then open <http://localhost:8080/>.

## Structure

```
docs/
├── index.html              # landing page
├── pages/
│   ├── settings.html       # sample Settings reference
│   └── dsl.html            # sample DSL reference
└── assets/
    ├── css/styles.css      # all styles
    ├── js/search.js        # vanilla client-side search
    ├── data/search-index.json  # search corpus (hand-maintained for now)
    └── screenshots/        # capture targets — see placeholders in pages
```

## Search

Search is keyword-based, no fuzzy matching. The index in
`assets/data/search-index.json` is hand-maintained at this stage; a build
step that walks rendered pages and emits the index automatically is planned.

## Screenshots

Each page has `<div class="screenshot-placeholder">` blocks marking spots
where a real CLI / report / REPL capture goes. Filenames are quoted inside
each placeholder — drop the PNG into `assets/screenshots/` with the matching
name and replace the placeholder div with an `<img>` tag.

## Next iteration

- Auto-generate `assets/data/search-index.json` from rendered HTML
- Auto-generate the Settings reference from `pgwen.conf` key reads in `src/`
- Auto-generate the DSL reference from `src/dsl/` pattern registrations
- Fill in the stub sidebar entries (Annotations, Reports, Authoring features, …)
- Capture screenshots for every placeholder
