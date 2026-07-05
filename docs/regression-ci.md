# Regression-pack CI gate

The `experiment/pgwen-regression` pack — 19 features, 125 scenarios —
is the parity guard for pgwen itself. Every framework change must keep
the pack green; that's the gate this CI surface enforces.

## What it runs

```
yarn install
yarn build
yarn test              # Vitest unit + integration tests
yarn test:regression   # ../pgwen-regression pack
```

`test:regression` shells into `../pgwen-regression`, installs
dependencies via the frozen lockfile, and runs `yarn pgwen` against the
`Regression.conf` profile. The regression pack resolves `@pgwen/core`
via the local `file:../pgwen` reference, so it always picks up the
pgwen build at the current HEAD.

## Where it runs

- **GitHub-flavoured CI:** `.github/workflows/regression.yml` in this
  repo. Triggers on PRs touching `src/`, `tests/`, `pgwen-fix/`, or
  build config, and on pushes to `main`.
- **Jenkins / Azure Pipelines / GitHub Actions:** mirror the workflow stages in a Jenkinsfile. The yarn
  scripts + `playwright install --with-deps chromium` are the only host
  requirements.

## Wall-clock budget

| Stage | Local | CI cold |
|---|---|---|
| Install + build | 5–10 s | 60–90 s |
| Vitest unit tests (3339) | 3 s | 5–10 s |
| Playwright install | n/a | 30–45 s |
| Regression pack | ~35 s | 50–70 s |
| **Total** | ~50 s | 3–5 min |

Hard cap in the workflow is 10 minutes — a hung scenario aborts.

## Failure artefacts

When the regression pack fails, the workflow uploads
`pgwen/output/reports/` as an artifact named `regression-html-report`.
Reviewers click through to the HTML index, see the failing scenario, and
get the full step trail without re-running locally.

## Internal npm registry (optional)

If your org proxies npm through an internal registry, the Node.js setup step
honours `secrets.PGWEN_NPM_REGISTRY` — set it to your proxy URL (e.g.
`https://nexus.example.com/repository/npm-proxy/`) in the repo's GitHub
Actions secrets. On a personal fork without the secret, the workflow falls
back to public npm automatically.

## Why this gate matters

The regression pack routinely catches DSL-surface regressions that unit tests
miss. Without the gate, a pgwen change can land on `main` and break downstream
projects silently — the next consumer to
migration round becomes the bug-discovery layer, which is too late.
