# Parallel work: lanes, branches, and the merge queue

How several sessions (human or agent) build on this repo at the same time
without stepping on each other. Grounded in the actual collision points we hit
while landing 16 PRs in two overnight batches (2026-07-16).

## What actually collides here

1. **Drizzle migrations** — numbering is sequential, so any two branches that
   each add a migration conflict on `apps/api/drizzle/meta/_journal.json` and
   claim the same `00NN_*.sql` slot.
2. **Generated files** — `docs/api/openapi.json` and
   `packages/sdk/src/generated/` change whenever anyone touches API surface.
   These conflicts are *fake*: the files are build artifacts committed for the
   CI drift check.
3. **Hotspot files** — very large UI files that many features route through:
   `apps/web/src/app/w/[ws]/d/[db]/r/[rec]/page.tsx`,
   `apps/web/src/components/table-view/field-dialogs.tsx`,
   `apps/web/src/components/table-view/table-view.tsx`,
   `apps/api/src/relations/relations.service.ts`.
4. **The merge gate** — main requires up-to-date + green CI, which serializes
   *merging* even when *building* was parallel. The merge queue fixes this.

## Lanes

Branch names carry a lane prefix so every session can see what's claimed:

| Lane | Branch prefix | Owns | Parallel-safe? |
|------|--------------|------|----------------|
| Docs | `docs/…` | `docs/**` (deploys to docs.storyos.dev on its own) | always |
| MCP | `mcp/…` | `packages/mcp/**` | unless `packages/schemas` changes |
| API | `api/…` | `apps/api/**`, `packages/schemas/**` | one-migration rule |
| Web | `web/…` | `apps/web/**` | hotspot rule |
| Fixes | `fix/…`, `chore/…` | cross-cutting | check overlap first |

The marketing site lives in a separate repo (`storyos-website`) and never
interacts with these lanes.

## The three rules

1. **One migration in flight.** Before adding a drizzle migration, check open
   PRs for `apps/api/drizzle/` changes. If one exists, queue behind it (or
   coordinate). A branch that rebases over someone else's migration must
   delete its own `00NN_*` files, take main's `meta/`, and re-run
   `pnpm --filter @storyos/api db:generate` so the migration renumbers onto
   the next free slot.
2. **Never hand-merge generated files.** On any conflict or drift-check
   failure in `docs/api/openapi.json` / `packages/sdk/src/generated/`:
   take main's version, then regenerate —
   ```sh
   git checkout origin/main -- docs/api/openapi.json packages/sdk/src/generated
   pnpm --filter @storyos/schemas build && pnpm sdk:generate
   ```
   Commit the result. Never resolve these hunks by hand.
3. **One branch per hotspot.** ~~Only one in-flight branch may touch a hotspot
   file at a time.~~ **Relaxed (#197, 2026-07-17):** the four hotspots were
   decomposed into focused modules — the record page into
   `components/entity/*`, `field-dialogs.tsx` into ten per-dialog files,
   `table-view.tsx`'s `BatchBar`/`HeaderCell` into siblings, and relation
   auto-link into `auto-link.service.ts`. Work now lands in a small module, so
   branches no longer collide on one giant file. Still check open PRs before a
   change to `table-view.tsx` itself (the remaining ~600-line `TableView` core).

## Session mechanics

- **One worktree per session.** Parallel sessions must not branch-switch a
  shared checkout — use `git worktree` (Claude Code sessions: EnterWorktree)
  so each session has an isolated tree.
- **Claim tickets in the backlog** (`storyos/issues` over MCP): set the issue
  to In Progress before starting, so two sessions never build the same thing.
- **Full local CI before pushing**: `pnpm lint && pnpm typecheck && pnpm test
  && pnpm build && pnpm docs:check && pnpm install --frozen-lockfile`, plus
  the SDK drift check if API surface changed.

## Merging

`main` is protected by the "protect main" ruleset (linear history, required
`ci` check). With auto-merge enabled and the merge queue on, the flow is:

1. Open the PR; when CI is green, click **Merge when ready** (or
   `gh pr merge --squash --auto`).
2. The queue rebases, re-runs `ci` against the queued merge result, and lands
   it — no manual rebase train.

The `ci` workflow runs on `merge_group` events for exactly this reason — do
not remove that trigger, or queued PRs will stall waiting for a check that
never starts.

## Deploys

- Code lanes deploy together: `cd /root/storyOS && git pull && docker compose
  up -d --build web api mcp`. Migrations run on api boot — watch
  `docker compose logs -f api` when a deploy carries one.
- The docs lane deploys itself via the Cloudflare Workers build on merge; no
  docker deploy needed.
