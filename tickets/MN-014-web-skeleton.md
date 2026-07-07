---
id: MN-014
title: Web skeleton — auth + app shell
status: todo
depends_on: [MN-013]
size: M
---

Next.js app bootstrapped: Tailwind + shadcn/ui init, login/signup/reset pages via the better-auth client (Google button env-gated), protected `/w/[workspace]` shell, TanStack Query wired to the SDK, workspace creation from empty state. Hard rule enforced by lint: the web app talks to the API **only** through `packages/sdk` — no server-side DB access, ever.

## Acceptance criteria

- [ ] Full auth flow in the browser: signup, verify, login, logout, reset
- [ ] Unauthenticated visits to `/w/*` redirect to login and back after auth
- [ ] ESLint rule blocks importing `apps/api` internals or DB clients from `apps/web`
- [ ] Workspace creation flow (name → created → land in shell)
- [ ] Base layout: sidebar placeholder, topbar, error/loading states, toasts
