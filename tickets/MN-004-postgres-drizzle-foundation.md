---
id: MN-004
title: Postgres + Drizzle foundation + integration-test harness
status: todo
depends_on: [MN-001]
size: M
---

Database foundation: `docker-compose.dev.yml` (Postgres 16), Drizzle client + drizzle-kit migrations, migration #1 creating `workspaces`, `spaces`, `memberships`, `invites` (auth tables land with MN-006). Integration-test harness: Testcontainers Postgres locally, `services: postgres` in GitHub Actions — the harness only needs a `DATABASE_URL`. Schema per [docs/architecture/meta-model.md](../docs/architecture/meta-model.md).

## Acceptance criteria

- [ ] `pnpm db:migrate` bootstraps a clean database; migrations are committed plain-SQL files
- [ ] `pnpm db:generate` produces a new migration from schema changes
- [ ] Example integration test round-trips a workspace row — green locally (Testcontainers) and in CI (service container)
- [ ] Per-test-file DB reset strategy implemented and documented in docs/architecture/overview.md (testing section)
- [ ] Required Postgres extensions enabled in migration #1 (`pg_trgm`)
