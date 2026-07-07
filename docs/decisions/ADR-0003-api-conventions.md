# ADR-0003: API conventions

- **Status:** accepted
- **Date:** 2026-07-07

## Context

The API is the product surface (API-first). It must be predictable for external consumers (scripts, MCP servers) and stable enough to commit an OpenAPI contract. Record queries need arbitrary filter trees, which don't fit GET query params.

## Decision

- Base path `/api/v1`; JSON only; UUIDv7 ids; `Authorization: Bearer` (session token or `mn_pat_` PAT) or session cookie.
- **`POST /databases/:id/records/query`** with a filter-AST body (and/or nesting ≤3, ≤50 conditions) — same model saved views use. `GET /records` stays for the trivial case. (Notion's API made the same call.)
- **Keyset cursor pagination only** — opaque base64url `{sort_values, id}`; `id` always appended as sort tiebreaker. No offsets anywhere.
- **One error envelope** from a global exception filter: `{error: {code, message, details[], request_id}}` with stable code slugs; 409 + current version for optimistic-concurrency conflicts; guests get 404 (not 403) for unshared spaces.
- Values keyed by stable **`api_name`** in payloads; schema introspection endpoints expose enough metadata for generic clients.
- OpenAPI 3.1 generated from nestjs-zod DTOs at build → committed `docs/api/openapi.json` (reviewable contract diffs) → SDK regenerated → CI drift check. Scalar at `/api/docs`.
- Rate limiting via `@nestjs/throttler`, keyed per token/session, env-configurable defaults.

## Consequences

- Contract changes are visible in every PR diff; breaking changes require deliberate `/api/v2` work.
- The filter AST is shared verbatim between views and the query endpoint — one compiler, one op×type matrix ([../architecture/api-conventions.md](../architecture/api-conventions.md)).
- MCP servers and integrations need zero product changes: introspect schema, query records, mutate — all public.
