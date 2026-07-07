# Stack

Locked in [ADR-0001](../decisions/ADR-0001-stack.md). Optimized for: API-first as a structural property, OSS contributions, and agent-driven development (conventional, well-documented patterns; boring, proven tech).

## Chosen

| Layer | Choice | Why (short) |
|---|---|---|
| Repo | pnpm workspaces + Turborepo | Standard TS monorepo; cached pipelines |
| API | NestJS 11 + Fastify adapter | Most convention-heavy Node framework → predictable agent output; first-class OpenAPI (`@nestjs/swagger`) and testing; standalone service makes "UI eats its own dog food" structural |
| Web | Next.js 16 App Router | Mostly a client-side SPA over the API; SDK-only data access enforced by lint rule |
| DB | PostgreSQL 16 (only datastore) | JSONB + GIN/trgm covers v1; one thing to operate |
| ORM | **Drizzle** | The defining workload is dynamic queries over JSONB keyed by runtime field ids — Drizzle's `sql` fragments compose raw SQL safely inside typed queries; drizzle-kit = plain-SQL migrations (readable in OSS PRs, run at container boot); no codegen binary/rust engine in Docker |
| Auth | better-auth (+ own PAT table) | Email/password + Google OAuth out of the box, Drizzle adapter, DB sessions; PATs are a 60-line guard we control — see [auth.md](auth.md) |
| Editor | BlockNote | Notion-style blocks, slash menu, drag handles, stable JSON doc format day-zero; it's Tiptap/ProseMirror underneath, so the escape hatch exists |
| UI kit | shadcn/ui + Tailwind | Copy-paste components agents know cold; Radix a11y; no lock-in |
| Table | TanStack Table + TanStack Virtual | Headless + virtualized; the canonical pairing |
| DnD | dnd-kit | Most examples/training-data coverage; view-layer only, swappable |
| Data fetching | TanStack Query over the generated SDK | Optimistic updates for cell edits and kanban moves |
| Validation | zod in `packages/schemas` | Single source of truth for every body; shared API/web/SDK |
| API contract | nestjs-zod → OpenAPI 3.1 → committed spec → `openapi-typescript` + `openapi-fetch` SDK | Contract diffs reviewable; CI drift check |
| Testing | Vitest · supertest + real Postgres (Testcontainers local / `services:` in CI) · Playwright (~6 smokes) | Real-DB integration tests; heaviest suites on query compiler + value validator |
| CI/CD | GitHub Actions · GHCR images | PR: lint→typecheck→unit→integration→build→OpenAPI drift; main: +Playwright, +publish |
| Self-host | Docker multi-stage, multi-arch; compose = postgres + api + web (+ MinIO profile) | `docker compose up -d`; migrations on boot |
| Ordering | `fractional-indexing` npm | Boring standard for LexoRank-style keys |

## Rejected (and why)

- **Single full-stack Next.js:** route handlers make the API second-class (weak OpenAPI story, constant temptation to bypass it via server components). API-first is a hard requirement.
- **tRPC:** not a public REST API; PAT/MCP consumers need REST + OpenAPI.
- **Bare Fastify/Hono:** less convention → more agent drift.
- **Go/Rust API:** outside the founder's ecosystem; kills iteration speed.
- **Prisma:** great for static schemas; our dynamic JSONB filter/sort engine would live entirely in `$queryRaw`, losing most of its value; rust engine complicates multi-arch Docker.
- **Kysely:** excellent query builder but no migration toolkit; Drizzle ≈ Kysely-ish querying + migrations in one.
- **Lucia:** deprecated to a learning resource. **NextAuth/Auth.js:** couples auth to the Next app — wrong side of the wire. **Custom JWT:** weeks of undifferentiated security work.
- **Raw Tiptap:** 2–3 weeks assembling slash menus/drag/placeholders to reach BlockNote's day-zero UX.
- **pragmatic-drag-and-drop:** technically excellent, less community coverage than dnd-kit; swappable later.
