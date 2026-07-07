---
id: MN-013
title: Generated SDK package
status: done
depends_on: [MN-012]
size: S
---

`packages/sdk`: `openapi-typescript` + `openapi-fetch` client generated from the committed `docs/api/openapi.json`. Regen script, CI drift check (spec ↔ SDK), typed error-envelope helper. This is what the web app (MN-014) — and any community script — consumes.

## Acceptance criteria

- [ ] `pnpm sdk:generate` produces a compiling, typed client
- [ ] Sample script (signup → create database → add field → create record → query) runs green against a local dev API
- [ ] CI fails if `openapi.json` and the generated SDK diverge
- [ ] Error helper narrows the envelope (`code`, `details`) for consumers; publishable package config stubbed (not published yet)
