# Contributing to StoryOS

Human or AI agent, **read before you write code.** Most of the rules below exist because breaking them cost us something real, and the reason is usually written next to the rule.

## Orientation

1. **What it is:** [README.md](README.md) and [docs.storyos.dev](https://docs.storyos.dev).
2. **How it's built:** [docs/architecture/overview.md](docs/architecture/overview.md) and the [ADRs](docs/decisions/README.md). ADRs are decisions; don't relitigate them in code. If you disagree, propose a superseding ADR.
3. **How parallel work stays safe:** [docs/architecture/parallel-work.md](docs/architecture/parallel-work.md). Read it before your first branch.

## Finding and proposing work

- **Open a GitHub issue first** for anything bigger than a typo: a bug with steps to reproduce, or a proposal with the problem it solves. Maintainers track accepted work in StoryOS (we use our own product) and reference it in PRs as `ticket #N`.
- **A bug report needs evidence, not interpretation.** Say what you did, what you expected, and what actually happened, and quote the response or attach the screenshot. "It seems broken" can't be fixed.
- `tickets/MN-###` is the original build backlog, kept as history. Don't start new work from it.

## Trunk-based development

`main` is the trunk and the only long-lived branch. There are no `staging`, `production` or release branches.

- **Branches are short-lived.** Merge within a day or two. A branch that lives for weeks drifts from `main` and turns its merge into a project of its own.
- **Keep PRs small.** One ticket, one concern. A small diff gets a real review and clears the merge queue fast. If a change keeps growing, split it and land the safe half first.
- **`main` is always deployable.** Every merge builds the images and deploys that exact commit to staging (`build-images.yml`, the `deploy staging` job) within minutes. Don't merge something you wouldn't want running there.
- **Production ships when a person decides.** A maintainer runs `Deploy production` with a green `main` sha. Rolling back means running it again with the previous sha. Nothing is promoted through branches.

### Unfinished work: merge it switched off

Don't hold a feature on a branch until it's finished. Merge it in small steps, switched off, and switch it on when it's ready. There is no general feature-flag system yet, so use the smallest switch that already exists:

- **UI-only:** a named constant that stops the UI rendering, e.g. `SHOW_LEGACY_ZONING_UI` in `record-detail.tsx`.
- **Server features and integrations:** an env-gated `enabled()` check. Source providers do this: a disabled provider is hidden from the list and rejected on create.
- Per-workspace `featureFlags` on entitlement overrides are **recorded but not enforced**. Don't build on them.

Every flag names its ticket in a comment, and **removing the flag is part of that ticket's Done**. A flag that outlives its feature is dead code that still looks like a decision.

## Branches and commits

Work in **your own branch, in your own worktree**. Never switch branches in a checkout another session may be using.

Branch names carry a **lane prefix**:

| Prefix | Owns |
|---|---|
| `api/…` | `apps/api/**`, `packages/schemas/**` |
| `web/…` | `apps/web/**` |
| `mcp/…` | `packages/mcp/**` |
| `docs/…` | `apps/docs/**`, `docs/**` |
| `fix/…`, `chore/…` | cross-cutting changes |

Commits and PR titles follow Conventional Commits and name the ticket:

```
fix(api): computed record title is computed from what the caller may read (ticket #884)
```

**Sign off every commit** with `git commit -s`. That adds `Signed-off-by:`, which is your acceptance of the [CLA](CLA.md) for that contribution, and the DCO check fails without it.

## Rules that get PRs bounced

**Architecture**
- **API-first.** The web app talks to the API only through `@storyos/sdk`. No database access from `apps/web`, and no private endpoints.
- **The seams stay clean.** All record access goes through the `RecordsRepository` seam, and filter→SQL logic lives only in the query compiler ([ADR-0002](docs/decisions/ADR-0002-record-storage-jsonb.md)).
- **A new API capability ships with its MCP tool in the same PR,** or with an entry in `packages/mcp/src/coverage.ts` saying why not. `coverage.test.ts` fails otherwise. "Nobody asked for it" isn't a reason.
- **An MCP tool's description is an instruction to every connected AI.** It has to match what the code actually does. A stale description makes models act on a false claim.

**Tests**
- **Every endpoint ships with at least one happy-path and one authz integration test.**
- **A test must be able to fail.** Before you trust a new test, break the thing it guards and watch it go red. A test that asserts the behaviour you *meant* to ship, rather than the behaviour you *did* ship, defends the bug.
- For permissions, assert against the **served response**, not the source code or a screenshot of the UI.

**Shared files**
- **One database migration in flight at a time.** Check open PRs for `apps/api/drizzle/` changes before adding one. If your branch rebases over someone else's migration, delete your `00NN_*` files, take main's `meta/`, and re-run `pnpm --filter @storyos/api db:generate`.
- **Never hand-merge generated files.** On a conflict in `docs/api/openapi.json` or `packages/sdk/src/generated/`, take main's version and regenerate:
  ```bash
  git checkout origin/main -- docs/api/openapi.json packages/sdk/src/generated
  pnpm --filter @storyos/schemas build && pnpm sdk:generate
  ```
- **Declare overlaps.** CI's collision check asks GitHub whether another open PR touches a file yours touches. Overlap is allowed, but it must be declared on its own line in the PR description: `Overlaps-With: #NNN — why`.
- **Secrets never reach git.** Keys live in `.env` only.

## Before you push

Run the full local CI. A failure after push wastes a merge-queue slot.

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm docs:check && pnpm install --frozen-lockfile
```

- If you changed API surface, run `pnpm sdk:generate` and commit the drift. CI checks for it.
- If you touched `packages/mcp`, the image must still build: `docker build -f docker/mcp.Dockerfile .`
- Never pipe `pnpm test` into `head`. Turbo hangs with no output, and it looks like a slow run.

## Opening the PR

Say three things in the description:

1. **What changed and why**, with the ticket.
2. **What you verified**, and how: tests, a browser at a stated width, a quoted API response.
3. **What you did NOT verify.** A PR that claims everything is checked will be read as if it were. Naming your own limits is what makes a review trustworthy.

Meet every acceptance criterion on the ticket, or say which one you didn't and why.

## How a PR lands

- `main` is protected: linear history, a required `ci` check, and a **merge queue** that rebases and re-tests the merge result before it lands. A diff that touches only docs (`apps/docs/`, `docs/`, `tickets/`, or Markdown outside `apps/` and `packages/`) skips the API and package test jobs and still runs lint, typecheck, docs links and the build; if CI can't tell, it runs everything.
- **Authors don't merge their own work.** A maintainer verifies the PR against the ticket's acceptance criteria, in a browser wherever a criterion describes something a person sees. Then they merge it, send it back, or ask a question. Nobody verifies their own work, because the misunderstanding that produces a bug also produces the test that misses it.
- **"Done" includes the docs.** If your change is visible to users, the docs site has to describe it. Changes that are visible to self-hosters or contributors need the matching page under `docs/` or `apps/docs/`.

## Versions

Node ≥ 22 and pnpm 10. Current majors: NestJS 11, Next.js 16, React 19, TypeScript 6, zod 4, ESLint 10. Some older planning docs mention earlier majors; the versions above are what's in use.

## Licensing

StoryOS is [dual-licensed](docs/licensing.md): **AGPL-3.0-or-later for everyone,** plus a separate commercial license for organisations that can't accept the AGPL. To keep that possible, every contribution carries a copyright grant under the [Contributor License Agreement](CLA.md). You keep ownership of your work; the CLA lets the project also license it commercially. Read it before your first PR. Your `Signed-off-by:` line is your acceptance.
