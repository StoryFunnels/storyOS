---
id: MN-001
title: Monorepo scaffold
status: done
depends_on: []
size: S
---

Set up the pnpm + Turborepo monorepo: `apps/api` (NestJS hello-world on :3001), `apps/web` (Next.js hello-world on :3000), `packages/schemas`, `packages/sdk` (stub), `packages/config` (shared tsconfig/eslint). Strict TypeScript everywhere, ESLint + Prettier, root scripts. See [ADR-0001](../docs/decisions/ADR-0001-stack.md).

## Acceptance criteria

- [ ] `pnpm build`, `pnpm lint`, `pnpm typecheck` pass from the root with Turborepo caching
- [ ] `pnpm dev` runs api on :3001 and web on :3000 concurrently
- [ ] `packages/schemas` exports a sample zod schema imported by both apps (proves the wiring)
- [ ] Strict TS (`strict: true`, no implicit any) via shared tsconfig in `packages/config`
- [ ] README quickstart section works on a clean machine (documented node/pnpm versions)
