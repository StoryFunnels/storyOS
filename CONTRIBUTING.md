# Contributing to StoryOS

Whether you're a human or an AI agent: **read the docs before writing code.** This repo is docs-first by design.

## Orientation (2 minutes)

1. What we're building → [docs/product/vision.md](docs/product/vision.md) · what's in/out → [docs/product/v1-scope.md](docs/product/v1-scope.md)
2. How it's built → [docs/architecture/overview.md](docs/architecture/overview.md) + the [ADRs](docs/decisions/README.md)
3. What to build next → [tickets/README.md](tickets/README.md) (sequenced backlog, `MN-###`)

## Working a ticket

- Each `tickets/MN-###-*.md` file is a self-contained work spec: description, acceptance criteria, doc pointers.
- One ticket = one commit/PR, message prefixed `MN-###:`. Flip the ticket's `status:` frontmatter to `done` in the same commit.
- Meet every acceptance criterion or say explicitly in the PR which one you didn't and why.

## Rules that get PRs bounced

- **API-first:** the web app talks to the API only through `@storyos/sdk`. No server-side DB access from `apps/web`, no private endpoints.
- **The seams stay clean:** all record access goes through `RecordsRepository`; filter→SQL logic lives only in the query compiler ([ADR-0002](docs/decisions/ADR-0002-record-storage-jsonb.md)).
- **Don't relitigate ADRs in code.** Disagree? Open a superseding ADR proposal instead.
- **Every endpoint ships with ≥1 happy-path + ≥1 authz integration test.**
- **Contract changes are visible:** if `docs/api/openapi.json` changes, that diff is part of the review.

## Commands

```bash
pnpm dev          # api :3001 + web :3000
pnpm build        # all packages
pnpm lint && pnpm typecheck && pnpm test
pnpm docs:check   # verify intra-repo markdown links
```

## Versions

Node ≥22, pnpm 10. Current majors: NestJS 11, Next.js 16, React 19, TypeScript 6, zod 4, Drizzle latest. (Planning docs occasionally say "NestJS 10 / Next 15" — written before scaffold; the newer majors are the reality.)

## Recommended branch protection (once on GitHub)

Require CI green + one review on `main`; squash merges; linear history.
