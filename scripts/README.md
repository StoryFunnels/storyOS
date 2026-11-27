# scripts/

One-line index of the scripts that are not wired into CI by name. Each file's header comment is its documentation; the CI ones (`ci-gate`,
`collision-check`, `docs-only-changed`, ...) are described where `ci.yml` calls them.

- `linear-probe.mjs` — **read-only** probe of Linear, run once with a Linear API key before the first real import (`LINEAR_API_KEY=... node scripts/linear-probe.mjs --teams ISSUE,SF`). The key is read from the environment only and never printed; it makes no StoryOS call and writes nothing. It counts teams, issues, identifiers, dates, states and people, measures the importer's query cost, and prints each fact next to what the StoryOS mirror predicted.
