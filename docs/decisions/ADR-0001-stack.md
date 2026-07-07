# ADR-0001: Stack — TypeScript monorepo, NestJS + Next.js + Postgres + Drizzle

- **Status:** accepted
- **Date:** 2026-07-07

## Context

API-first is a hard product requirement: the web UI must be client #1 of the same public REST API external consumers (scripts, MCP servers) use. Development is done by a solo founder plus AI agents, so we optimize for conventional, heavily-documented patterns over cleverness. The product is open source; contributors must find the codebase predictable. The defining data workload is dynamic queries over user-defined schemas (JSONB keyed by runtime field ids).

## Decision

- **pnpm + Turborepo monorepo**: `apps/api` (NestJS 10, Fastify adapter), `apps/web` (Next.js 15), `packages/schemas` (zod), `packages/sdk` (generated client).
- **NestJS over full-stack Next.js**: a standalone API service makes API-first structural, not aspirational; Nest's rigid module/controller/service/guard/DTO conventions produce consistent agent output; first-class OpenAPI and testing.
- **PostgreSQL 16 as the only datastore.**
- **Drizzle ORM**: `sql` template fragments compose raw SQL safely inside typed queries (exactly the shape of the record query engine); drizzle-kit plain-SQL migrations are readable in OSS PRs and run at container boot; no codegen binary in Docker builds.
- **better-auth** for identity (email/password + env-gated Google OAuth, DB-backed sessions) + our own PAT table with a unified guard.
- **BlockNote** editor; **shadcn/ui + Tailwind**; **TanStack Table/Virtual/Query**; **dnd-kit**; **zod + nestjs-zod → OpenAPI 3.1 → openapi-fetch SDK**; **Vitest / supertest+real-Postgres / Playwright**; **GitHub Actions + GHCR**.

Rejected: single Next.js full-stack, tRPC, bare Fastify/Hono, non-TS backends, Prisma, Kysely, Lucia, Auth.js, custom JWT, raw Tiptap, pragmatic-drag-and-drop. Details in [../architecture/stack.md](../architecture/stack.md).

## Consequences

- Two deployables (api, web) instead of one — accepted cost of structural API-first.
- Drizzle's rawer edges vs Prisma's DX — accepted for SQL composition power where it matters most.
- Everything else is deliberately boring; novelty budget is spent on the product's meta-model, not the stack.
