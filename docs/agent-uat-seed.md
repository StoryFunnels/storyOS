# Seeding the agent UAT environments

`seed:agent-uat` fills a StoryOS database with a workspace that looks like a
year of real use, so the agents who use the product as a customer would are
reporting bugs about StoryOS rather than about having no data.

This is not garnish. #404 is the precedent: a table view passed every test and
every local check on a three-record demo workspace, then broke on a real 148-row
× 22-column database — for exactly the users who matter. An operator testing an
empty environment reproduces that blind spot every single day.

## Running it

```sh
DATABASE_URL=postgres://you@localhost:5432/storyos_nadia pnpm db:migrate
DATABASE_URL=postgres://you@localhost:5432/storyos_nadia LOG_LEVEL=warn \
  pnpm seed:agent-uat --persona nadia
```

| Flag | Meaning |
|---|---|
| `--persona nadia\|kai` | Which environment to build. Required. |
| `--seed <value>` | Anything; defaults to `1`. The same seed always produces the same data. |
| `--scale <n>` | Multiplies record counts. `1` is the real environment; the tests use `0.02`. Never changes the shape. |
| `--dry-run` | Print the plan and its hash, write nothing. |

`LOG_LEVEL=warn` is worth setting: without it the request log for several
hundred API calls buries the seeder's own progress output.

## What you get

**Nadia** — the big one. Eleven client workspaces, deliberately uneven (two
large, six medium, three nearly empty, because uniform fixtures hide pagination
and layout bugs), 18 databases, ~2,380 records with one database over 500 so
virtualization and paging are genuinely exercised. Six months of backdated
history spread over ~183 distinct days, with some records edited more than once
so version history and activity feeds have something to page through. One
self-relation and one cross-space relation — the two shapes that break diagrams
and filters. A workflow field with more options than fit comfortably on a board.

Her flagship workspace also carries the surfaces an agency actually meets:
~113 **attached files** (PNG, PDF and text, all tiny and obviously synthetic)
uploaded through the real multipart endpoint so they genuinely download; an
**Invoices** database with sample rows, from applying the product's own
`client-work` agency template; and a **Client Portal**, installed from the
`client-portal` starter pack through the marketplace install path. Neither is
hand-built — a seeder's impression of an invoice is not an invoice.

A **guest** holds partial access to the portal and Delivery — two of the
flagship's five spaces. Only guests can hold partial access, so an
access-boundary test without one proves nothing; and a client portal the client
cannot open is not a portal.

**Kai** — one workspace, ~900 records weighted toward documents and rich text
rather than structure, ~86 attached files (a denser file-to-record ratio than
Nadia's — he is the operator who pastes and drops things), and deliberately
messy: half-filled records, untitled rows, records with a single field set. The
states a fast solo user actually leaves behind.

Every name is obviously synthetic — "Northwind Consulting", never a plausible
agency. Screenshots from these environments get pasted into tickets, and nobody
should ever have to stop and work out whether a client name in one is real. The
founder chose generated data over cloning a real workspace for the same reason:
these environments run unattended, and real client names and emails on that
machine would be a standing risk for no benefit.

## Re-running it, and the reset that is not here

Running it again is safe and **additive**: a workspace is matched by its slug
(derived from persona + seed), a template or pack by the space it creates, and
a file by its name on its record. Only what is missing gets created. Nothing
existing is touched, and nothing is deleted. A second full run takes about two
seconds and creates nothing.

Files are checked per file rather than "did this run create the record", so an
environment seeded before attachments existed gains them on the next run
instead of never getting them.

**There is deliberately no `--reset` flag.** These environments are persistent
on purpose and the accumulated data is the instrument — an agent that has been
working an environment for a month has a month of state that is part of what it
is testing. If you genuinely want to start over, do it explicitly:

```sh
dropdb storyos_nadia && createdb storyos_nadia
DATABASE_URL=postgres://you@localhost:5432/storyos_nadia pnpm db:migrate
```

That should be a decision, not a flag someone reaches for out of habit.

## Determinism

The same `--seed` produces the same data: names, values, timestamps, structure
and link topology are all generated from a seeded PRNG with no clock and no
`Math.random`, anchored to a fixed epoch. A bug Nadia finds on Tuesday against
`--seed 1` reproduces on Wednesday.

Two things are **not** byte-identical and cannot be: record ids and public
record numbers, which the server allocates. The seeder prints a plan hash
(`plan a1b2c3…`) so two environments can be compared without diffing postgres.

## How it writes

Through the product's own HTTP API, not raw SQL — so seeding exercises
validation, field defaults, computed titles, record numbering, link writing and
rollups exactly as a user does. A seeder that writes straight to postgres will
happily produce a workspace the product itself could never have created, and
then the bug it hides is the seeder's.

Two narrow, deliberate exceptions, both in `apps/api/src/seed/apply.ts`:

1. **`created_at` / `updated_at` backdating.** No endpoint accepts a past
   timestamp — correctly, since a client must not be able to forge history — so
   rows are created through the API and then stamped in one update.
2. **Version-row dates**, stamped the same way, so a record's history sits
   inside the record's own life rather than at seed time. The versions
   themselves are real, written by real `PATCH` calls.

The API rate-limits at `RATE_LIMIT_PER_MINUTE` (300 by default) and the seeder
makes well over a thousand calls, so it waits out a 429 and retries rather than
skipping the call. That is most of why a full Nadia run takes ~75 seconds
rather than ~20. Every other non-2xx is fatal: an earlier version swallowed
them and produced an environment missing an entire workspace's links while
reporting success.

**Order matters between the pack and the template.** The `client-portal` pack
ships databases called Tasks, Deliverables, Meetings and Requests; the
`client-work` template ships a Tasks of its own. Applying the template first
makes the pack install `409` on a real name collision — and for databases the
only resolution the product offers is `reuse`, which would bolt the portal's
client-approval workflow onto an unrelated table. The seeder installs packs
first, into a workspace whose databases are all named `<Project> Tasks`, where
nothing collides.

**Records are addressed by index**, so `listRecordIds` sorts by the public
record number to return them in creation order. `records/query` returns view
order, and backdating scrambles anything date-ordered; past the 200-row page
boundary a re-run mapped index N to a different record and uploaded a second
copy of every file.

## Where the agent setup instructions live

The agent prompts and `setup-agents.sh` were moved out of this repository
(PR #461), so the copy of the setup instructions that tells an operator to run
this lives in `~/storyos-envs/`, not here. Its step 3 still reads
*"(separate ticket — not yet built)"* and needs that removed.

## Files

| Path | What |
|---|---|
| `apps/api/src/seed/rng.ts` | Seeded PRNG, stream forking, the fixed epoch |
| `apps/api/src/seed/vocab.ts` | The obviously-synthetic words |
| `apps/api/src/seed/plan.ts` | Pure plan generation — no database, no clock |
| `apps/api/src/seed/apply.ts` | Writes a plan through the API |
| `apps/api/src/seed/agent-uat.ts` | The CLI |
| `apps/api/test/seed-agent-uat.unit.test.ts` | Determinism and shape |
| `apps/api/test/seed-agent-uat.test.ts` | Seeds a real database, twice |
