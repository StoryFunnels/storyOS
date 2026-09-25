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
3. **Collisions between in-flight branches are checked in CI, not listed
   here.** `scripts/collision-check.mjs` asks GitHub on every PR whether
   another open PR already touches a file yours touches. An overlap is
   allowed, but it must be *declared* — `Overlaps-With: #NNN — why` in the PR
   description. Every "cannot tell" fails the build; unresolvable must never
   read as "no problem".

   **This replaced a list of four hotspot filenames, and how that list failed
   is the reason not to write another one.** It named
   `table-view/field-dialogs.tsx`, which stopped existing at commit `2669191`
   — the commit titled *"decompose the four hotspot files into focused
   modules"*. Meanwhile `table-view/field-dialog-shared.tsx`, which inherited
   that file's traffic (13 commits in 60 days, more than `relations.service.ts`
   at 9), was never named at all; and the rule still protected
   `r/[rec]/page.tsx`, by then 656 bytes and 3 commits in 60 days. **A filename
   is a proxy for collision risk. The proxy drifted and the rule went on
   asserting it.** Do not reintroduce a list because a list is easier to write
   than a mechanism.
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

## Tyron (#356–#364) — the rules that must hold in CODE, not in the prompt

Full ADR: [docs/decisions/ADR-0016-tyron-conversational-runtime.md](docs/decisions/ADR-0016-tyron-conversational-runtime.md).
The load-bearing ones, each of which shipped as a bug first:

- **The system prompt is not a mechanism.** Its own comment says every line is a
  rule the model can ignore, and twice now it was ignored: #401 (invented a count
  of 50 when the real figure was 148) and #405 (a confident zero about a database
  that does not exist). Anything that MUST hold is enforced in the turn loop —
  see `grounding.ts`.
- **Never guess numbers.** A quantity about workspace data must come from a tool
  call on that turn. Zero counts as a quantity, and is the most dangerous one: a
  wrong number invites checking, a confident zero does not.
- **Counting must not be done by fetching.** `query_records` paginates, so
  counting its results returns the size of one page. Use the aggregate endpoint /
  `count_records` (#404).
- **Tool results are capped and history is trimmed, and both SAY SO** in the text
  the model reads. Silent truncation manufactures confident wrong answers.
- **actor = the member, `source` = `agent`.** Tyron never appears as an actor.
  The provenance lives on the token row (`api_tokens.origin`), not a header — a
  header is forgeable by whoever holds the token (#357).
- **A thread is private, including from admins; suppress at EMIT time.** Nothing
  emits yet, so this is an obligation inherited by the first feature that does.
  ADR-0016 §6 has the detail.

## Members / the people model (#128 / #320) — read the ADR before touching assignees

Workspace people are a **one-way projection** of `memberships` + better-auth into
an ordinary system database. Full ADR:
[docs/decisions/ADR-0017-members-people-model.md](docs/decisions/ADR-0017-members-people-model.md).
The load-bearing facts:

- **Identity is the `is_system` FLAG, never the display name.** Matching by name
  handed a user's own "Members" database to the projection, which then rewrote
  their schema and wrote every colleague's email into their records (#317/#318).
  The flag cannot be set over HTTP, so it cannot be forged.
- **Removal TOMBSTONES** (`active = false`), it never deletes — assigned records
  must keep a resolvable Member, and `resolveMembersForUsers` deliberately
  returns inactive rows rather than erroring.
- **Guests get rows**; "viewer" is a grant role from ADR-0007, not a person type,
  and no grant data is projected.
- **An assignee is still a bare user id in a `user` field** — NOT a Members
  relation. `resolveMembersForUsers` exists but has **no production caller**, so
  do not read the code as "Members already backs assignees". The cutover (#145)
  should run through ADR-0012's guided conversion, not a bespoke migration.
- The ADR carries **nine OPEN questions**, including that the Members database
  has no write protection at all. Answer one there before relying on it.

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
- **Publishing is a ONE-WAY move**; coming back is "Copy to My Space" — a fork with
  no sync (#293). Moving out of Personal makes the item exportable again.

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
- **Access: the space is the door, each source is the room.** The door is
  `visibleSpaceIds` + `canSeePersonal`, **never `assertSpace`** — a guest with a
  database-scoped grant sees the space in their sidebar but fails `assertSpace`,
  so that combination 404s a space the product just showed them. Then resolve
  every source against the **viewer** with `effectiveForDatabase`
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

The version-history initiative has a design +
codebase-inventory ADR that C-tickets must follow:
[docs/architecture/version-history.md](docs/architecture/version-history.md).
The load-bearing facts: **extend** MN-231 `record_versions` + its list/restore
API (don't replace them); capture is **field-level** (`record_field_changes`)
badged by `source` (human/agent/automation/mcp — threaded in #390, NOT #330);
retention is
plan-gated and tiny (Free none · Pro 1d · Business 7d · Enterprise 30d), Free =
capture off; whole-record restore ships before per-field revert; this is
history/restore, **not** workspace backup (#320/#322).

**Ticket numbers in this block were wrong and are now removed.** It cited the
initiative as #321 (really: the field-type picker labels), C2–C5 as #363–#366
(really: Tyron tickets), and the `source` badge as #330 (really: a Done billing
-tip bug). Stale numbering from the old MN-* scheme, of the same class #363
flags about itself. A load-bearing rule pointing at four unrelated tickets is
worse than no rule, so the claims stand on their own and only #390 — which
actually did the `source` work — is cited.

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

**A new API capability ships with its MCP tool in the SAME PR — or an entry in
`packages/mcp/src/coverage.ts` saying why not** (#397). StoryOS is agent-first:
a capability the MCP cannot reach effectively does not exist for the product's
main consumer, and four such gaps accumulated unnoticed before anyone counted.
`coverage.test.ts` fails on an endpoint that has neither a tool nor an entry, so
this is enforced rather than remembered. An exclusion needs a real reason;
"nobody asked for it" is not one, and a genuine gap goes in `DEFERRED` with a
ticket rather than being disguised as a decision.

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

## When a check is wrong about what it checks

Every rule below exists because a check was real, passed honestly, and was
blind to the thing it was written to catch. The shared shape, and the sentence
worth remembering:

> **A verification whose scope silently differs from the thing it claims to
> verify.**

It has now appeared in five costumes, all within two weeks, none of them
carelessness:

- **A grep matching a class shape**, whose population was then reported as the
  population of the thing. `border border-border-default bg-card px-2` is worn
  by `<input>` *and* `<select>`; "42 hand-rolled inputs" was neither 42 nor
  inputs. Same error twice — "four hand-rolled segmented controls" was four of
  seven, and one of the three missed sat 840 lines below one that was migrated,
  in the same file.
- **A fixture that is a prefix of reality.** A unit test named *"storyos/issues'
  REAL schema"* used its first 8 of 27 fields, stopping ten positions before
  the field that broke the rule. It was green; the product was wrong. **A
  fixture that is a prefix of reality passes for exactly the cases it omits.**
- **A check that ran and detected nothing for four days.** The contrast
  advisory's diff half died on a shallow clone with no `origin/main`, printed
  "Diff check skipped" and exited 0 — while an accepted 174-site tail rested on
  the claim that new sites would be caught.
- **A rule naming a file that had moved** — rule 3 above, for weeks.
- **An assertion outliving its defect, and quietly specifying it.** An
  assertion written to prevent a filter-chip collapse survived eight days past
  the fix that removed the collapse; built to as written, it would have
  reintroduced the defect. This is the worst of the five: the others were
  checks that missed something, **this one was the defence itself.**

**The general test is one question:** does the evidence come from the thing, or
from the way you looked for it? If a search term produced the set, find what
actually *created* the set — a commit, a decomposition, a convention — before
reporting it as complete.

### Re-verify a ticket's premise at CLAIM time, against main

Not at file time, and not against a summary. A ticket is written in good faith
and then ages while the repo moves: ticket #737 asked for a type scale that had
shipped eleven days earlier; ticket #738 cited two tickets as live proof of a gap both
had already closed. **Against `main`, specifically** — not a local worktree. A
checkout eight days stale invalidated a day of otherwise careful work.

Before writing code, run the premise:

- Does the thing the premise **names** still exist? One `git cat-file -e` per
  named path.
- If it cites a ticket as proof, what **state** is that ticket in *now*? One
  read.
- Is the set defined by the repo, or by your search term?
- **Premises of the form "X does not exist" are the ones that rot** — true when
  written, quietly false later, and nothing fails to compile. Before filing a
  defect someone handed you verbally, search whether it is already ticketed or
  already shipped. "File it" is an instruction, not evidence of novelty.

If the premise has moved, **say so on the ticket before writing code.**

### Resolve a PR by (repo, number), never by number alone

A successful call and a landed fact are not the same thing. In
`storyos/github_pull_requests`, **151 PR numbers appear in more than one repo**,
and storyOS's own sync stopped at PR #463 (ticket #666) — so "look up PR #838"
for a
storyOS ticket returns a real record, with a plausible title and a genuinely
stale timestamp, **from a different repository**. A drift check built on number
alone reports "silent for three weeks" about an unrelated repo, with total
confidence and no indication anything is wrong.

So: resolve by the pair, and when a PR cannot be resolved, **fail loudly**.
Never treat unresolvable as "no movement". And a send-back is two writes to two
systems — posting the review is not the same fact as the ticket moving; confirm
both.

## Verification honesty

Tested backend claims need tests; interactive UI claims need a live browser
click-through (dev servers: web :3000, api :3001 — see `.claude/launch.json`).
Say plainly in the PR what was verified how, and what wasn't.
