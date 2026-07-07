---
id: MN-032
title: Seed templates + onboarding
status: done
depends_on: [MN-018, MN-023, MN-026]
size: M
---

Template system v0: JSON template definitions in-repo + `POST /workspaces/:ws/templates/:slug/apply` (installs via ordinary internal calls to the public API paths: space → databases → fields → relations → options → views → sample records tagged as sample). Ship **Client Projects & Tasks** and **Content Pipeline** exactly per [docs/product/templates.md](../docs/product/templates.md); Blank = checklist empty state. New-workspace flow offers the template picker; "Remove sample data" banner button; the 4-step onboarding checklist overlay. `pnpm seed:demo` for local dev. Playwright demo-flow smoke. **This ticket closes v1: the JCM demo.**

## Acceptance criteria

- [ ] Applying a template creates its space, databases, fields, relations, options, views, and sample data in < 5 s
- [ ] A new user can: sign up → pick Client Projects & Tasks → drag a task on the kanban → comment on it — zero manual schema setup (Playwright covers this end-to-end)
- [ ] "Remove sample data" deletes exactly the tagged records
- [ ] Template JSON format documented so contributors can add templates
- [ ] `pnpm seed:demo` is idempotent
- [ ] Onboarding checklist tracks its 4 steps and dismisses
