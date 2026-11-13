# The standing local Pinewood stack

One StoryOS, running `main`, on one Mac, that every screenshot and check of `main` uses. **Local only**: no staging, no hosted copy. Ticket #1269.

Pinewood Studio is the fake marketing agency whose data fills it. Every name in it is synthetic; real client or customer data never goes into the template, the seed or a fixture.

| | |
|---|---|
| API | `http://localhost:3500` |
| Web | `http://localhost:3600` (use this for screenshots of `main`) |
| Database | `storyos_pinewood` (persistent, never dropped) |
| Template | `storyos_agency_tpl` (disposable, rebuilt from `main`) |
| Clone it runs from | `~/storyos-envs/pinewood/` (its own clone, never an agent's worktree) |

Both processes run non-watch (`node dist`, `next start`), not `pnpm dev`. They are not the dev ports (3000/3001), so they never collide with a worktree rig.

## Bringing it up to date: `pinewood-up.sh`

One owner runs this after each merge batch. **Agents never restart the stack themselves**, so nobody fights over the ports.

```sh
scripts/pinewood/pinewood-up.sh --dry-run    # print the plan, change nothing
scripts/pinewood/pinewood-up.sh --init       # first time only: clone, then everything below
scripts/pinewood/pinewood-up.sh              # every other time
```

It prints its plan, refuses anything unsafe (below), then:

1. `git pull --ff-only origin main` in the clone. It never resets or discards anything.
2. `pnpm install --frozen-lockfile`, only if `pnpm-lock.yaml` changed.
3. Builds the API and the web app at that sha, unless that sha is already built. The web build bakes in `NEXT_PUBLIC_API_URL=http://localhost:3500`.
4. Creates `storyos_pinewood` if it is missing, then migrates it.
5. Runs `seed:agency` as a refresh, once that command exists (see "Not built yet").
6. Stops the two processes **it** started (recorded in its state directory, matched by working directory), starts the new ones.
7. Health check: the API answers, `/healthz` reports the database up, the web app answers, and the **running** API reports the sha the clone is at. It prints that sha and exits non-zero if any of that is false.

Run it twice in a row and it ends healthy at the same sha with the same data. The second run skips the install and the builds.

To use the short path the house rules name, put a one-line wrapper next to the other agent tooling (outside the repository; it is machine-local):

```sh
printf '#!/bin/sh\nexec "$HOME/storyos-envs/pinewood/scripts/pinewood/pinewood-up.sh" "$@"\n' > ~/storyos-envs/bin/pinewood-up.sh
chmod +x ~/storyos-envs/bin/pinewood-up.sh
```

The script reads itself completely before it pulls, so updating itself in step 1 is safe.

### Where things live

| | Default | Override |
|---|---|---|
| Clone | `~/storyos-envs/pinewood` | `PINEWOOD_HOME` |
| Pids, logs, build stamps, attachments | `~/storyos-envs/pinewood-state` | `PINEWOOD_STATE` |
| Throwaway secrets | `~/storyos-envs/pinewood.env` | `PINEWOOD_ENV_FILE` |
| Database | `storyos_pinewood` | `PINEWOOD_DB` |
| Ports | API `3500`, web `3600` | `PINEWOOD_API_PORT`, `PINEWOOD_WEB_PORT` |

`pinewood.env` is generated on first run (mode 600) with random `BETTER_AUTH_SECRET` and `CONNECTIONS_MASTER_KEY`. It protects a local database of fake data and nothing else. It is outside the clone and never in git. Logs are `api.log` and `web.log` in the state directory.

## Rigs from the template: `pinewood-template.sh`, `pinewood-rig.sh`

PR testing stays on each agent's own rig. The rig's database is a copy of the template, so a PR's screenshots and `main`'s show the same agency, in seconds instead of a re-seed.

```sh
scripts/pinewood/pinewood-template.sh                 # rebuild storyos_agency_tpl from main (after a migration or seed change)
scripts/pinewood/pinewood-rig.sh marek_1269           # createdb -T storyos_agency_tpl storyos_marek_1269, then migrate THIS worktree on top
```

`pinewood-rig.sh` prints how many migrations the template carried and how many your checkout added, then the `DATABASE_URL` to use. Re-running it leaves an existing rig's data alone and only migrates; `--recreate` drops that one rig database and clones again. Use a session-unique rig name: two sessions sharing `storyos_test_local` look exactly like a regression.

The template is the only database any of these scripts will ever `DROP`, and only because it is rebuilt from scratch. Nothing here can drop `storyos_pinewood`.

## What it refuses

Each of these exits with code 2 and a `pinewood: REFUSED:` line, before anything is created or changed. Each has a test in `scripts/pinewood.test.mjs`, and each test was checked by breaking the guard and watching it fail.

- A database that is not `storyos_pinewood*` (or, for the template and rig scripts, not a template or rig name). `umh_analytics`, `storyos` (the shared founder database), `postgres` and the template databases are named as protected.
- A Postgres host that is not `localhost`, `127.0.0.1` or `::1`.
- A clone that is a git worktree (its `.git` is a file), sits under a `.claude/worktrees` path, is not named `pinewood*`, is not on `main`, has local changes, or contains `apps/api/.env` or `apps/web/.env.local` (a stray `.env` could override the stack's configuration, for example with a real mail key).
- The ordinary dev ports 3000 and 3001, ports outside 1024-65535, or the API and web on the same port.
- A port held by a process this script did not start. It never signals a process it cannot prove is its own.

It also never trusts the shell it runs in. An exported `DATABASE_URL` is ignored (and said so), and every child process runs under `env -i` with only `PATH`, `HOME` and the stack's own variables, so a `RESEND_API_KEY` or `STRIPE_SECRET_KEY` in your shell cannot reach Pinewood. Every database-touching command goes through one function that re-checks the database name and host immediately before handing over `DATABASE_URL`.

## Using it

- Screenshots and checks of `main`: `http://localhost:3600`.
- Browser cookies on `localhost` are shared across ports. If you are also signed in to a rig on `localhost:3000`, use a separate browser profile for Pinewood, or the two sessions overwrite each other.
- If the stack looks stale, ask the owner to run `pinewood-up.sh`; do not start your own on the same ports.

## The agency dataset: `seed:agency`

Ticket #1297. `pnpm --filter @storyos/api seed:agency` loads **Pinewood Studio**, a fake marketing agency, through the product's own HTTP API (so record numbers, links, member projection, agent attribution and the approval gate behave as in production). `pinewood-up.sh` runs it as a refresh and `pinewood-template.sh` runs it when it builds the template, so a rig cloned from the template shows the same agency.

What it makes: a workspace `pinewood-studio` with the Agency OS, Deal Desk and Team Board packs (their `(sample)` rows are left out), plus Enquiries and Invoices databases; 7 clients (Maple Street Bakery, Harbor Dental and Kerr Plumbing among them), 11 contacts, 12 enquiries, 12 jobs (Agency OS projects), 24 tasks (two overdue), 9 quotes, 8 invoices, 4 team tasks: 87 records. Three comments written by agents through a real agent token (they read as `source: agent`), and one pending approval raised by a real approval-gated automation rule. Dates are offsets from the day it first ran, with timestamps in daytime.

**Every name is invented.** Emails use the reserved `.example` TLD. Nothing is derived from a real client, customer or tracker; keep it that way when you add to it.

| Login | Role |
|---|---|
| `maya.chen@pinewood.example` | admin (creates the workspace) |
| `dana.okafor@pinewood.example` | admin |
| `omar.haddad@`, `lena.brandt@`, `jonah.whitfield@` | member |
| `rosa.alvarez@pinewood.example` | guest (Client Work space only) |
| `vera@`, `marek@pinewood.example` | admin |
| `iris@`, `dara@pinewood.example` | member |
| `nils@pinewood.example` | guest (Client Work space only) |

All of them share one throwaway password, which is **never in git**. It is read from `PINEWOOD_SEED_PASSWORD`, else from the same key in `~/storyos-envs/pinewood.env` (`PINEWOOD_ENV_FILE`), else generated once and appended to that file (mode 600). The scripts run it under `env -i`, so the file is what carries it. To sign in, read it from that file. The seed refuses an env file inside a git checkout.

Running it again changes nothing: a record is "there" when a record of that title is in that database, so a re-run creates only what is missing and never edits or deletes what is there (your own records and edits survive). There is no reset flag. To start the agency over, drop the database yourself. If a login already exists with another password the seed stops and says so.

`seed:agency` refuses, with exit code 2 before the app boots, the same things the shell scripts do: a database that is not `storyos_pinewood*` (or the `storyos_agency_tpl*` template the stack builds), the protected names including the shared founder database `storyos`, an unset `DATABASE_URL` (the API's own default is the founder database), a non-local host, a `host=`/`hostaddr=` override in the URL, and `NODE_ENV=production`. `apps/api/test/seed-agency-guard.test.ts` holds both rule sets to each other by feeding the same names to `lib.sh`.

To give the studio room for eleven people it sets a seat allowance on the workspace through the entitlements service (the seam the admin panel uses); the Free plan's two seats would refuse its own invites.

## Not built yet

Nothing from ticket #1269's dataset list is missing. Still to do by hand: the screenshots the ticket asks for (table, board, record page, Inbox), and a real `pinewood-up.sh` / `pinewood-template.sh` run once this is on `main` (the scripts call `seed:agency` from the clone's `main`, so they only pick it up after the merge).
