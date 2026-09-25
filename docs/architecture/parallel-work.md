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
3. **Files two open PRs both touch** — most often a large UI file that many
   features route through. This used to be a list of four filenames here and
   in CLAUDE.md; it is now computed per PR by `scripts/collision-check.mjs`,
   for the reason in rule 3 below.
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
3. **Declare overlaps; CI computes them.** ~~Only one in-flight branch may
   touch a hotspot file at a time.~~ ~~**Relaxed (#197, 2026-07-17):** the four
   hotspots were decomposed into focused modules, so branches no longer collide
   on one giant file.~~ **Replaced (ticket #747, 2026-09-25):**
   `scripts/collision-check.mjs` runs on every PR and asks GitHub whether
   another open PR already touches a file yours touches. Overlap is allowed but
   must be declared — `Overlaps-With: #NNN — why` in the PR description — and
   every "cannot tell" fails the build.

   **Both struck-through versions are kept on purpose**, because this rule has
   now gone stale twice in the same way and the shape of the failure is the
   argument for the mechanism. The original named `field-dialogs.tsx`, which
   stopped existing at commit `2669191`. The #197 relaxation that replaced it
   then drifted too: it said the decomposition produced "ten per-dialog files"
   (there are four — `add-field-dialog.tsx`, `change-type-dialog.tsx`,
   `edit-field-dialog.tsx`, `field-dialog-shared.tsx`) and described a
   "remaining ~600-line `TableView` core" that is 1,380 lines. **A filename or
   a line count written into prose is a measurement taken once and then
   asserted forever.** Let CI take the measurement.

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
