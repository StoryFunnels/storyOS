# Architecture overview

## Guiding principles

- **API-first is the architecture**, not a feature. The web app is client #1 of the same public REST API that PATs and MCP servers hit. No private endpoints, no "internal" shortcuts.
- **Boring, conventional, heavily-documented tech.** Every choice is the one with the most training-data coverage and the most googleable failure modes, because AI agents write most of the code. See [stack.md](stack.md) and [ADR-0001](../decisions/ADR-0001-stack.md).
- **One datastore (Postgres), one repo, one `docker compose up`.**

## Topology

```
apps/web (Next.js 16)  ──HTTP──▶  apps/api (NestJS 11 / Fastify)  ──▶  PostgreSQL 16
        │                                 │
        └── packages/sdk (generated) ─────┘── packages/schemas (zod, shared validation)
                                          └── attachments: local disk or S3-compatible (MinIO)
```

- **apps/api** — NestJS with the Fastify adapter. Modules: auth, workspaces, spaces, databases, fields, records, relations, views, documents, comments, activity, attachments, tokens. Serves `/api/v1`, `/api/v1/openapi.json`, Scalar docs at `/api/docs`, `/healthz`.
- **apps/web** — Next.js App Router, mostly a client-side SPA over the API. Talks to the API exclusively through `packages/sdk` (enforced by lint rule on imports — no server-side DB access, ever).
- **packages/schemas** — zod schemas: every request/response body, the filter AST, and the record-value validator. Single source of truth shared by API (validation), web (types), SDK.
- **packages/sdk** — `openapi-typescript` + `openapi-fetch` client generated from the committed OpenAPI spec; CI fails on drift.

## Request path

1. Request hits Fastify with `Authorization: Bearer <token>` (session token or `mn_pat_` PAT) or the better-auth session cookie.
2. Unified `AuthGuard` resolves identity from either source ([auth.md](auth.md)).
3. `WorkspaceAccessGuard` resolves membership + role (+ guest space scoping) once per request.
4. `ZodValidationPipe` validates the body against the shared schema → 400 envelope with per-path details on failure.
5. Service layer performs the mutation and writes `activity_events` in the same transaction.
6. Exception filter normalizes all errors into the single envelope ([api-conventions.md](api-conventions.md)).

## Multi-tenancy

Every query is scoped through `workspace_id` in the service layer. Guests are additionally scoped to `memberships.space_ids`; resources outside their spaces return **404** (never 403 — don't leak existence). No Postgres RLS in v1 — app-layer scoping with per-endpoint authz integration tests; RLS is a noted hardening step for managed cloud.

## The one seam that matters

All record reads/writes go through `RecordsRepository` and the filter-AST→SQL **query compiler** — isolated modules, never smeared through controllers. This is the seam that lets us migrate storage strategies later without touching the public API ([ADR-0002](../decisions/ADR-0002-record-storage-jsonb.md)).

## Realtime & events

None in v1. UI uses TanStack Query with optimistic updates + refetch. The append-only `activity_events` table is the future outbox for webhooks (v1.1, [ADR-0004](../decisions/ADR-0004-no-webhooks-v1.md)) and any later realtime layer (SSE first).

## Testing & CI

- **Unit:** Vitest. The query compiler and record-value validator get the densest suites in the repo.
- **API integration:** supertest against a real Nest app + real Postgres (Testcontainers locally, `services: postgres` in GitHub Actions — the harness only needs `DATABASE_URL`, provided to workers via vitest `globalSetup` → `provide/inject`). Migrations run once per test run; test files run serially (`fileParallelism: false`) and truncate the tables they touch (`truncateAll` helper — workspace cascade wipes all tenant data). Every endpoint: ≥1 happy path + ≥1 authz test.
- **E2E:** Playwright, ~6 smoke flows (signup → create db → add field → add record → kanban drag → comment).
- **CI:** PR = lint → typecheck → unit → integration → build → OpenAPI-drift check. Main additionally runs Playwright and publishes Docker images.

## Self-hosting

Two images (`api`, `web`), multi-stage builds, multi-arch (amd64/arm64). `docker-compose.yml` = postgres + api (runs migrations on boot) + web + optional MinIO profile for S3-compatible attachment storage. Backup = `pg_dump` (+ attachment volume). Upgrade = pull + up.
