# StoryOS

An open-source, self-hostable work platform built around one idea: **user-defined relational databases that can run an entire company** — client and task tracking, content pipelines, social calendars, lightweight CRM — all on the same engine. Think Fibery's model (databases + relations + views + entity pages), open source, API-first.

> **Status:** pre-code. This repo currently contains the complete v1 planning docs and development backlog. Coding starts at [tickets/MN-001](tickets/MN-001-monorepo-scaffold.md).

## Principles

1. **Relations are the core primitive.** A database without relations is a spreadsheet. Connecting databases is the easiest, most obvious action in the product.
2. **API-first, no exceptions.** The web UI is client #1 of the same public, versioned REST API everyone else gets. If the UI can do it, a script or an MCP server can do it.
3. **Capability is never paywalled.** The self-hosted core is fully capable, free forever (AGPL-3.0). Future monetization is managed hosting and AI on top — never crippling the engine.
4. **Structure over documents.** The unit of work is a record in a user-defined database, not a page in a tree.
5. **Schema is data.** Databases, fields, relations, and views are API resources with stable IDs. Changing schema is a runtime API call, not a migration.
6. **Boring, predictable, self-hostable.** One Postgres, one API, one `docker compose up`. Runs a 10-person agency on a $10 VPS.
7. **Small surface, deep quality.** Two view types that work flawlessly beat six at 70%.

## Name

**StoryOS** — decided 2026-07-07. Domains: `storyos.dev` (project/docs) and `storyos.cloud` (future managed hosting). Package scope: `@storyos/*`. Ticket prefix stays `MN-###` (history is history). The local folder name `my-notion` is a leftover codename, harmless.

## Repo map

| Path | What's there |
|---|---|
| [docs/product/](docs/product/) | Vision & personas, use cases, ~50 user stories, key flows, starter templates, v1 scope cut |
| [docs/architecture/](docs/architecture/) | System overview, canonical meta-model, record storage design, API conventions, auth, stack |
| [docs/design/](docs/design/design-system.md) | Design tokens & UI direction (Attio structure, warm Borderlands palette) |
| [docs/decisions/](docs/decisions/) | ADRs — the decisions we don't relitigate |
| [docs/api/](docs/api/) | API guides; `openapi.json` will be generated from code |
| [tickets/](tickets/) | The v1 backlog: MN-001 … MN-032, sequenced. Start here to build |

## Where to start

- Want to understand **what** we're building → [docs/product/vision.md](docs/product/vision.md), then [docs/product/v1-scope.md](docs/product/v1-scope.md)
- Want to understand **how** → [docs/architecture/overview.md](docs/architecture/overview.md), then [docs/decisions/](docs/decisions/)
- Want to **build** → [tickets/README.md](tickets/README.md)

## Stack (locked in [ADR-0001](docs/decisions/ADR-0001-stack.md))

TypeScript monorepo (pnpm + Turborepo) · NestJS 10 API (Fastify) · Next.js 15 web · PostgreSQL (only datastore) · Drizzle ORM · better-auth · BlockNote editor · shadcn/ui + Tailwind · zod everywhere · OpenAPI 3.1 generated from code.

## License

[AGPL-3.0](LICENSE). Free for everyone, forever. If you host it as a service, share your changes back.
