# StoryOS — agent session rules

Monorepo: pnpm + Turbo. `apps/api` (NestJS/Fastify), `apps/web` (Next.js),
`packages/schemas` (zod, shared), `packages/sdk` (generated), `packages/mcp`.

## Before you build

- **Tickets live in the StoryOS backlog** (`storyos/issues` via the StoryOS
  MCP), not in markdown files. Never build something new without a ticket;
  claim yours by setting it In Progress.
- **Branch names carry a lane prefix** — `docs/…`, `mcp/…`, `api/…`, `web/…`,
  `fix/…` — see `docs/architecture/parallel-work.md` for the lane rules.
- **Parallel sessions use separate git worktrees.** Never branch-switch a
  checkout another session may be using.

## Hard rules (they exist because each one bit us)

1. **One drizzle migration in flight across all open PRs.** Check open PRs for
   `apps/api/drizzle/` before generating one. On rebase over someone else's
   migration: drop yours, take main's `meta/`, re-run `db:generate`.
2. **Never hand-merge `docs/api/openapi.json` or `packages/sdk/src/generated/`.**
   Take main's version, then `pnpm --filter @storyos/schemas build && pnpm
   sdk:generate`, commit.
3. **One in-flight branch per hotspot file**
   (`w/[ws]/d/[db]/r/[rec]/page.tsx`, `table-view/field-dialogs.tsx`,
   `table-view/table-view.tsx`, `relations/relations.service.ts`).
4. **Secrets never reach git** — keys live in `.env` only.
5. **Don't mention the reference tool by name** in anything public-facing —
   code comments, docs, or commit messages say "the reference tool".

## Adding an integration (provider) — do it the tiered way

Every connection provider must be cloud/self-managed-correct by construction.
Full rationale + truth table:
[docs/architecture/integration-tiers.md](docs/architecture/integration-tiers.md).
The essentials, which every new-provider PR must satisfy:

- **Declare `tier`** on the descriptor (`apps/api/src/connections/providers/`)
  by *who owns the credential*: `api_key` (user's own key, works everywhere) ·
  `oauth_managed` (verified OAuth app — hosted provides it, self-managed
  operators bring their own via env) · `hosted_only` (cloud-only, reserved).
- **Tier B (`oauth_managed`):** define `oauth.clientIdEnv`/`clientSecretEnv`;
  do **not** add per-user OAuth-app/client-secret UI — it's an operator/env
  concern. Add operator docs + the redirect-URI note to the self-hosting
  integrations page.
- **Gallery must render the right state on self-managed** — no dead Connect
  button. `availabilityFor()` resolves `connectable` / `operator_config`
  (Tier B, self-managed, env absent — *not* an upsell) / `cloud_only` (Tier C
  off hosted).
- **Update the self-hosting integrations docs** (env vars + redirect URI).
- **Add/extend availability tests** across both deployment modes and (Tier B)
  env present/absent.

## Before you push

Run the full local CI — CI failures after push waste a queue slot:

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm docs:check \
  && pnpm install --frozen-lockfile
```

If you touched API surface: `pnpm sdk:generate` and commit the drift.
If you touched `packages/mcp` or its deps: the Docker image must still build
(`docker build -f docker/mcp.Dockerfile .`) — CI checks this too.

## Merging

Open the PR, wait for green, then `gh pr merge --squash --auto` — the merge
queue handles rebase + re-test + landing. Don't hand-drive rebase trains.

## Verification honesty

Tested backend claims need tests; interactive UI claims need a live browser
click-through (dev servers: web :3000, api :3001 — see `.claude/launch.json`).
Say plainly in the PR what was verified how, and what wasn't.
