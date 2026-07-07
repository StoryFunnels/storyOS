---
id: MN-003
title: CI pipeline
status: todo
depends_on: [MN-001]
size: S
---

GitHub Actions PR workflow: lint → typecheck → unit → build, with pnpm and Turborepo caching. (Integration tests join in MN-004; OpenAPI drift check in MN-005; Playwright + Docker publish come later.) Note: repo is local-only today — write the workflows now so day one on GitHub is turnkey.

## Acceptance criteria

- [ ] `.github/workflows/ci.yml` runs lint, typecheck, unit tests, build on PR and push to main
- [ ] pnpm store + turbo cache configured; second run visibly faster
- [ ] A deliberately failing test fails the workflow (verified once, then removed)
- [ ] Status badge placeholder in README; branch-protection recommendations documented in CONTRIBUTING.md
