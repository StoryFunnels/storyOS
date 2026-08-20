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

## Touching a field surface (cells, forms, pickers) — reuse, don't re-case

The same defect has shipped four times (#267, #272 twice, #303): a surface
re-implemented "how do I draw field type T" or "can field T do X", the copies
drifted, and nothing failed to compile. Full rationale + the checklist:
[docs/architecture/field-surfaces.md](docs/architecture/field-surfaces.md).
The load-bearing rules:

- **Render through `table-view/cells.tsx`** (`CellDisplay`/`CellEditor`,
  `OPTION_COLORS`, `OptionList`, `RelationChip`, `Avatar`). Different chrome
  wraps the shared control; it never re-renders it. Never copy styles between
  surfaces "to match" — that is how they drift again.
- **Never inline `.filter(f => f.type === …)`** for a capability gate. Use a
  named shared predicate (`components/views/groupable-fields.ts`), and where the
  server has the authority (`boardGroupError`), the predicate mirrors it and the
  comment says so.
- **Widen a renderer and its picker in the same commit** — a picker that offers
  less than its renderer draws (or more) IS the bug.
- **Unconfigured ≠ invalid.** Config-cleaning drops only *dangling* references;
  keeping mid-edit state is required (#305 deleted users' dashboard tiles by
  conflating the two).
- **Test the rejections and what a filter must KEEP** — #305's six existing
  assertions all passed unchanged under the corrected rule.

## Personal space (#87 / #290–#293) — the rules are decided, don't re-litigate

Per-member private space. Full ADR:
[docs/architecture/personal-space.md](docs/architecture/personal-space.md).
The load-bearing decisions:

- **Private from admins too**, and excluded from export. The accepted consequence:
  a departing member's personal content is unrecoverable — so the UI must say so,
  and removal must really delete, not hide.
- **Documents + views only. No private databases** in v1 (#296 revisits it).
- A personal **view is a lens on shared data**: deleting a record through it
  deletes it for everyone, so the confirmation names the blast radius. Deleting the
  view itself is safe. Databases are never reachable from a personal lens.
- **Mentions in personal content never notify** — suppress at EMIT time, never by
  filtering on read (a digest or Slack delivery would leak what the UI hides).
- **Promote/demote is reversible**; demoting does not recall notifications already
  sent.

## Where a view lives (#349 / #347 / #304 / #306) — decided, don't re-litigate

Ownership and placement are different questions. Full ADR:
[docs/architecture/views-and-the-sidebar.md](docs/architecture/views-and-the-sidebar.md).
The load-bearing decisions:

- **A view keeps its owning database AND gets a place in the sidebar tree.**
  The tree is `Space → Folder → ( Database | Document | View )` — the first two
  leaf types already existed (`space_folders`, MN-096). **Do not add a fourth
  container**; anything navigable becomes a leaf on this tree.
- **A view has a database XOR a space**, enforced by a CHECK (the
  `access_grants_scope_xor` precedent). Reject it in the controller too — a 500
  from a constraint violation is not an API contract.
- **A view's home falls out of its columns; there is no `placement` enum.**
  `folderId` set → it lives in that folder. One home at a time, never two.
- **Access: the space is the door, each source is the room.** Gate on the space,
  then resolve every source against the **viewer** with `effectiveForDatabase`
  (returns null — not `assertAccess`, which throws and would collapse the view).
  Zero readable sources → say so; never a 404, never an empty grid.
  **Only guests can have partial access**, so a test without a GUEST fixture
  proves nothing.
- **#291's privacy rule is unchanged** — only the "always has a database" half
  was amended. A personal view in a folder is still personal.
- **No user-mode toggle**, now or planned. Databases stay in the tree.

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

## Version history (change log, restore) — build to the ADR

The version-history initiative (#321; C2–C5 = #363–#366) has a design +
codebase-inventory ADR that C-tickets must follow:
[docs/architecture/version-history.md](docs/architecture/version-history.md).
The load-bearing facts: **extend** MN-231 `record_versions` + its list/restore
API (don't replace them); capture is **field-level** (`record_field_changes`)
badged by `source` (human/agent/automation/mcp via #330); retention is
plan-gated and tiny (Free none · Pro 1d · Business 7d · Enterprise 30d), Free =
capture off; whole-record restore ships before per-field revert; this is
history/restore, **not** workspace backup (#320/#322).

## Running the API tests without Docker (#98)

`apps/api/test/global-setup.ts` spins up a disposable `postgres:16-alpine` via
Testcontainers **only when `DATABASE_URL` is unset**. When Docker is down or its
image pull hangs (#98, recurring), supply one and Testcontainers is skipped:

```sh
createdb storyos_test_local
DATABASE_URL="postgres://$(whoami)@localhost:5432/storyos_test_local" \
  pnpm --filter @storyos/api test
```

- **Rebuild `@storyos/schemas` after switching branches**, before running API
  tests. `packages/schemas/dist` is shared across every branch and worktree, so
  a dist built on another branch silently drives the tests you are running —
  producing failures that belong to code you do not have checked out. Cost this
  three times in one session:

  ```sh
  pnpm --filter @storyos/schemas build
  ```

- **Use a fresh database per full run.** Reusing one makes `test/auth.test.ts`
  fail with 422 (its fixed signup email already exists) — a false failure that
  looks like a regression. `dropdb`/`createdb` before diagnosing.
- `test/backup-restore.test.ts` starts its own container regardless, so that one
  file still needs Docker — the single expected failure when Docker is down.

## Before you push

Run the full local CI — CI failures after push waste a queue slot:

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm docs:check \
  && pnpm install --frozen-lockfile
```

If you touched API surface: `pnpm sdk:generate` and commit the drift.
If you touched `packages/mcp` or its deps: the Docker image must still build
(`docker build -f docker/mcp.Dockerfile .`) — CI checks this too.

## Closing a ticket — docs and website are part of "done"

**Shipping code is not finishing a ticket.** ~200 issues shipped before anyone
noticed the website still described the old product and no blog post had been
written. Treat these as part of the definition of done:

- Dev work lives in `storyos/issues`.
- Documentation work lives in **`storyos/docs_tasks`** (NOT `storyos/docs`,
  which is a content LIBRARY of documents, not a tracker).
- Marketing-site work lives in **`storyos/website_tasks`**.

Both companion databases carry a `Source Issue` relation back to the issue, so
every one traces to the change that caused it.

**When you move an issue to Done**, make sure a Docs Task and a Website Task
exist for it and are linked. A StoryOS automation on the Issues database is
meant to create them; if it has not fired, create them by hand rather than
skipping — the automation is a convenience, the rule is the requirement.

**Closing a companion as "Not Needed" is a legitimate, one-click answer** and
often the right one — an internal refactor changes nothing a reader or visitor
would see. The point is that somebody DECIDED, not that every change generates
two more pieces of work. A backlog full of ignored companions is worse than
none.

**The website repo is `storyos-website`, a SEPARATE checkout** from this
monorepo (`/Users/ievgen/Documents/storyos-website`). Do not go looking for
`pricing.astro` in `apps/web`.

## Merging

Open the PR, wait for green, then `gh pr merge --squash --auto` — the merge
queue handles rebase + re-test + landing. Don't hand-drive rebase trains.

## Verification honesty

Tested backend claims need tests; interactive UI claims need a live browser
click-through (dev servers: web :3000, api :3001 — see `.claude/launch.json`).
Say plainly in the PR what was verified how, and what wasn't.
