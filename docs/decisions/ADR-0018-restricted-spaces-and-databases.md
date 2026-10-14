# ADR-0018: Restricted spaces and databases — members stop being workspace-wide

- **Status:** proposed (2026-10-14), for agreement before any build ticket is filed
- **Ticket:** #923 (design half: ticket #924). Decisions (a), (b), (c) were made by Ievgen on 2026-10-14, see below.
- **Supersedes:** the sentence in [ADR-0009](ADR-0009-contributor-rung.md) *"Members stay workspace-wide creators. No member scoping."* Everything else in ADR-0007 and ADR-0009 (the ladder, 404-not-403, grants at space/database/record scope, the ladder as the billing boundary) stands.
- **Companion:** [the inventory](../architecture/restricted-access-inventory.md) — every place that today special-cases guests, or assumes a member sees everything.

## Context

Members are workspace-wide creators by design. Only guests are narrowed, through `access_grants`. The Dr.Wunder workspace has 13 people (3 admins, 10 members) and one database with confidential information that every member can read. The published workaround, turning people into guests, takes away schema editing and @-mentions across the whole workspace, so it is not an answer.

The hard half already exists. Grants at space, database and record scope, the role ladder, and months of read-path narrowing for guests: search, relations, rollups, lookups, computed titles (ticket #884), notifications (ticket #880), activity, CSV, webhooks (ticket #920), public views (ticket #909), bound tokens (ticket #543). What is missing is applying that machinery to **members** when something is marked restricted.

## Decisions already made (Ievgen, 2026-10-14)

- **(a) Admins always see restricted content.** Restriction applies to members and guests only. A restricted space cannot become ownerless.
- **(b) Restricted is hidden completely**, not shown as locked. No grant means the same 404 a guest gets today: no name in the sidebar, no search hit, no count, no relation chip, no mention preview.
- **(c)** Which Dr.Wunder database, and who sees it, is Ievgen's, including any stopgap. It is not a build dependency.

## Decision

### 1. One flag, two tables

`spaces.restricted boolean not null default false` and `databases.restricted boolean not null default false`. Default false means **zero behaviour change** until an admin flips one. No migration of existing data.

Why a boolean and not a visibility enum: the ticket's two states are Everyone and Restricted, and an enum invites a third state (locked-but-visible) that decision (b) rules out. If a third state is ever wanted it is a migration from boolean to enum, which is cheap.

### 2. A resource is *open* or *closed*; the caller is *open-by-default* or not

```
openToMembers(database) = !database.restricted && !space(database).restricted
```

This is the whole model, and it is why it is small. **A guest is simply a caller for whom every resource is closed.** A member is a caller for whom a resource is closed only when it is restricted. An admin is a caller for whom nothing is closed.

```
effective(caller, resource):
  admin                                  -> 'admin'
  member and openToMembers(resource)     -> 'creator'          (today's behaviour, unchanged)
  otherwise                              -> max(applicable grants), or null  (404)
```

"Applicable grants" are exactly today's: a grant on the database, or on its space, or (for a record) on the record. Highest wins, as in ADR-0007. Grants only ever matter where the caller is not open-by-default; a member's grant on an open database is ignored (grants add, never subtract, as in ADR-0007).

A member who is granted `viewer` on a restricted database is a viewer there and a creator everywhere else. That is intended and is what Notion and Fibery do.

### 3. Restriction cascades down, grants cascade down, nothing cascades up

- Restricting a **space** closes every database in it. A grant on the space opens them all, **including a database in it that is itself flagged restricted** (v1; see open question 1).
- Restricting a **database** closes only it. It can sit in an open space: this is the Dr.Wunder case.
- A database **created** inside a restricted space is closed by inheritance; its creator holds the space grant already.
- A grant on a database makes its space *visible* in the sidebar with only that database in it. This is today's guest behaviour and it stays, for members too.
- **Personal spaces** are untouched (ADR-0006, `personal-space.md`): private from admins as well, and never a candidate for `restricted`.
- **Duplicate and move.** A duplicate of a restricted database is created restricted with the same grants (a member who holds a grant may duplicate it; otherwise admin only). Moving a restricted database into an open space keeps `restricted`. Today either operation could unrestrict it by landing in an open space or placing by space *name*; both are made id-based.
- **System databases** (the Members database, ADR-0017) cannot be restricted: people pickers and assignees depend on every member resolving it. The API rejects it with a 422.

### 4. ONE access function, not a second parallel one

`AccessService` today has a fast path (`admin`/`member` return immediately) and about ten guest-only primitives that each re-implement "guest grants" a little differently: `guestScopeIds`, `guestVisibility`, `visibleSpaceIds`, `visibleDatabaseIds`, `visibleRecordIds`, `guestRecordGrantIds`, `reachableDatabaseIds`, `effectiveForDatabase(s)`, `effectiveForRecord(s)`, `effectiveForSpace`. Three of them (`visibleDatabaseIds` in ticket #469, `effectiveForRecords`, the relation-chip readers) already shipped as drifting copies once.

The build replaces the **gate** inside those, not their callers:

1. Introduce `AccessService.narrowing(membership)`: resolves, once per request (reusing `memoizeForRequest`), a `NarrowingScope`:
   - `null` when nothing is closed for this caller (admin; or a member in a workspace with no restricted space or database; or any caller on a workspace where `restricted` is unused). **This is the fast path and it must stay one cheap query**, `select exists restricted` memoized per request, so the 99% case costs what it costs today.
   - otherwise `{ closedSpaceIds, closedDatabaseIds, grants }` for a member, or `{ grants }` for a guest.
2. Every primitive becomes a thin function of that scope. `membership.role !== 'guest'` stops being the test; `narrowing === null` becomes the test. Nothing in a *caller* has to learn about members, because callers already ask `visibleDatabaseIds` / `effectiveForDatabase`. The ones that branch on the **literal role** (the inventory lists them) are the real work.
3. SQL predicates are produced by the same scope, so a query that lists across databases (search, recent, favourites, My Work, global activity) composes one `readableDatabases(membership)` condition instead of fetching ids and filtering in memory.
4. `Membership.role` stays as it is (`admin | member | guest`); billing, invites and `MinRole` keep their meaning. We do **not** add a fourth role.
5. **One named predicate, `isNarrowed(membership)`**, replaces every literal `role === 'guest'` / `role !== 'guest'`. The inventory counts about twenty of them outside `AccessService` (records, titles, mention narrowing, activity, field conversion). The guard already does this for bound tokens (`workspace-access.guard.ts` rewrites the role to `'guest'`), which is the model: narrowing is a property of the caller, decided once.
6. **The guest primitives return allow-lists** (`guestScopeIds`, `guestVisibility`: "these ids are yours"). A member's visibility is "everything open, minus the closed, plus granted", which an allow-list cannot express. The scope therefore carries an explicit `unrestricted` flag (or an exclusion list); a caller must not be able to read "no restriction" from an empty set.
7. **Three kinds of site need three different fixes**, and the build must not treat them alike: literal role branches (replace with the predicate), member fast paths (`effectiveForDatabase(s)`, `effectiveForRecords`, `effectiveForSpace`: fix once, every caller follows), and **silent holes** that never ask access at all. The inventory found holes with no guest mention to grep for, for example `DatabasesService.create` (a member can create a database in a space they cannot see), `PATCH spaces/:space` (any member can rename a restricted space), the folder list (names of a restricted space), watchers, watcher and mention e-mail, and Slack. Those are the leak risk.

### 5. Every non-HTTP actor inherits, nobody gets a bypass

| actor | rule |
|---|---|
| Personal access token | acts as its owner; resolved live per request, never snapshotted (MN-125 lesson) |
| Bound token (ticket #543) | today a member owner gets `creator` on each listed entry. **Must change:** the grant becomes `min(creator, what the owner can reach)`, so a bound token can never be wider than its member |
| MCP / OAuth connected AI | the same member, the same answer (ticket #543 already routes them through the same guard) |
| Tyron / agents (ADR-0016) | actor is the member; an AI must not read what its human cannot |
| Automations | run as the rule's creator; a rule whose creator loses access to a database it touches **fails visibly** (a run error and a notification to the creator), never silently skips and never keeps working |
| Sources and importers (Shopify, Linear mirror, GitHub, ...) | write as the configuring admin or member; a write into a database the actor cannot reach is refused and recorded as a failed run |
| Notifications, watchers, e-mail, digests, Slack | **suppress at emit time** (the rule already used for personal space and threads): a recipient without access is dropped when the notification is created, never filtered when it is read |
| Public views, portal, forms | unaffected by who the viewer is, but a restricted database cannot be published or exposed to a public form without an explicit admin act (§9) |

### 6. Admin-only management in v1

Only admins set `restricted` and manage grants, exactly as grants are admin-only today (`grants.controller.ts`). A member with `creator` on a restricted database cannot add people to it. Open question 2.

**MCP.** `restricted` is a field on the existing `PATCH` for spaces and databases, so `update_space` and `update_database` (admin scope) gain it, and `list_spaces`, `list_databases`, `describe_database` expose it. **Adding or removing a person's access stays human-only**, keeping the ticket #441 exclusion in `coverage.ts` and the name guard in `tools.test.ts` (ADR-0010: an agent must not widen its own reach). The same PR edits `coverage.ts`, `TOOL_SCOPE` and that guard. `coverage.test.ts` does **not** catch a missing `restricted` input on an existing PATCH tool (the silent-gap shape of ticket #397), so it is added by hand and tested.

### 7. Members' record-scoped grants are out of scope

The primitives are role-agnostic, so record grants would work for members as a by-product. The v1 API **rejects** creating a record-scoped grant for a member (422), so the surface is not accidentally opened before it is designed, as the ticket asks.

### 8. Grants that already exist for members become live

A person promoted from guest to member keeps their `access_grants` rows. Today those are ignored for members. Under this ADR they matter the moment something is restricted. That is correct (an admin granted them), but it is surprising, so the Manage access dialog lists every holder of a grant on that scope regardless of role, and the build ticket includes a one-time admin report of member-held grants before the first resource is restricted in production.

Two defects the inventory found become real access paths and are fixed in phase 1:

- **Removing a member does not delete their grants** (`members.service.ts` `remove` deletes the membership, personal views and personal space only; grants go only on GDPR anonymize). A removed-then-re-invited member's old grants become live again, and `list_grants` lists grants for people no longer in the workspace. Removal must delete grants.
- **A member invite's grants are silently dropped** (`invites.service.ts:81` and `:238` apply grants only when `role === 'guest'`, although the invite schema accepts them for any role). "Invite a member straight into a restricted space" is the natural request, so either the invite carries and applies grants for members, or it rejects them with a 422. It must not discard them.

### 9. Derived data, outbound integrations and public sharing

The inventory found three families the model must answer, not leave implicit.

**Derived data (lookups, rollups, formulas, AI fields, computed titles).** A restricted database's values must not flow into an open one. Decision: **treat a member without a grant exactly as a guest is treated today** (the ticket #881 and #884 machinery: `hiddenDerived`, tainted fields removed from filter, sort and aggregate, `title_local`). That machinery is keyed on `isNarrowed`, so it applies to members for free once the predicate is the gate. Two additions: (1) **creating** a lookup, rollup or relation whose target is a restricted database requires read access to the target (today a creator on database A can copy a restricted database B's data into A, `fields.service.ts:896-921`; `RelationsService.create` and templates skip the check); (2) **AI fields** must not send values derived across a restricted boundary to the model provider.

**Outbound integrations** (workspace-wide webhooks, Google Calendar sync, the Linear mirror, GitHub PR comments, Slack). These are configured by admins and send data out of the product. Decision: workspace-wide webhook subscriptions **exclude restricted databases** (a subscription can still name one explicitly); integrations bound to one database keep working and say so in their settings; **nothing posts a restricted record's title to a third party on behalf of an unauthenticated outsider** (the GitHub PR-body backlink, `github-webhook.service.ts:375, 458`). Calendar bindings listing is admin-only (it is a guest leak today).

**Public sharing** (public views, forms, portal). Decision: **a restricted database cannot be published**, and an existing public view or form on a database that becomes restricted answers 404 until an admin unrestricts or re-confirms it. Forms and shared views must not resolve relation chips to a restricted target (anonymous visitors can list its titles and create records in it today, `forms.service.ts:354-396`).

## Mechanism so that nothing is missed

The inventory is a point-in-time list, and **a list is a proxy that drifts** (the lesson in `CLAUDE.md` rule 3). So the build adds a mechanism, not just the list:

- An **access coverage test**, modelled on `packages/mcp/src/coverage.ts` and its `coverage.test.ts`. It enumerates every API endpoint and requires each to be declared in an `ACCESS_COVERAGE` registry as exactly one of `scoped` (checks a space/database/record), `workspace-level` (touches no scoped content, with the reason), `admin-only`, or `public`. An endpoint that is in none of them **fails the build**. A new endpoint therefore cannot ship without someone deciding which it is, which is exactly the decision that was skipped every time a guest leak shipped.
- Every existing guest-narrowing test gets a **twin** for a restricted member (the inventory lists the tests). A fixture helper creates the third person: a member with no grant on a restricted database, so a test without that fixture proves nothing (the rule already recorded for guests in `views-and-the-sidebar.md`).
- The first production proof is the ticket's AC 6: restrict the Dr.Wunder database, sign in as a member without a grant, and confirm a 404, no search hit and no relation chip.

## Phasing (build tickets are filed against ticket #923 once this is agreed)

0. This ADR, the inventory and the Share / Manage access design (ticket #924, Dara).
1. **Foundation (API):** migration for the two columns; `narrowing()`, `isNarrowed()` and the primitives re-expressed on it; bound-token grants intersected; the coverage test with every endpoint classified (most as `workspace-level` at first, which is the visible backlog); twin tests for the primitives and the shared restricted-member fixture (`test/helpers/members.ts`; there is no shared guest fixture today, each test file hand-rolls its own). Also in this phase, because they are holes rather than sweeps: `assertSpace(creator)` **inside `DatabasesService.create`** (covers every creator at once), scope checks on `PATCH spaces/:space` and the folders routes, the database check in `space-views.updateById` and `move-to-space`, the role gate on the Google Calendar bindings list (a guest leak today), the by-id watchers routes and the batch-job read; grant cleanup on member removal; the invite decision above.
2. **Read-path sweep (API), one PR per module group** from the inventory (`restricted-access-inventory.md`, Parts 1 and 2), each with its twin tests: records and query; search, recent, favourites, My Work; databases and spaces lists, sidebar tree; relations, lookups, rollups, computed titles; mentions; activity, versions, audit; notifications and watchers; comments and files; views and dashboards; exports and webhooks; automations and sources.
3. **Management API and MCP parity in the same PR** (house rule): set `restricted`, list and edit grants for members, rejecting record grants for members and restriction of system databases.
4. **UI (Iris):** the Share / Manage access dialog on spaces and databases; the sidebar and pickers need nothing but the API's answer.
5. **Docs:** `concepts/access-and-roles` rewritten, removing "none is planned"; the guest-only wording in the other pages.
6. **Production proof**, then close.

Each phase ships alone and is safe alone, because nothing changes until `restricted` is set: that is the property the default of false buys.

## Open questions (none blocks phase 1)

1. **`restricted` on a database inside a restricted space.** v1 says a space grant opens it. The alternative is "sticky": a database flagged restricted stays closed to a space-grant holder until granted directly. Sticky is safer for confidential databases and one more rule; I recommend deciding it with the first real use.
2. **Who manages access** beyond admins: Notion lets whoever has full access on a page share it. v1 is admin-only; widening it to `creator` on that scope is an API change, not a model change.
3. **Per-record grants for members** later: the primitives support it; the question is only the UI and the audit.
4. **Groups** (the ticket's Share dialog mentions "people and groups"). There is no group concept in the schema today. v1 is people only; a group table is a separate decision and would expand to the same grant rows.
5. **Files** embedded in documents and records carry no scope (capability URLs): accept as unguessable, or add a scope column.
6. **Workspace export zip** carries no `restricted` marker, so restriction is lost on a restore; decide whether the zip carries flags and grants.
7. **Tyron thread history and approvals** keep tool output after access is revoked; the privacy rule exists, a revocation rule does not.
8. **Named approver** of an approval on a restricted database (today deliberate for guests, ticket #691).
9. **Billing** for a member holding only viewer grants: unchanged in v1 (a member is a seat), flagged for the pricing page.

## Consequences

- The published sentence "there's no per-space member restriction, and none is planned" is reversed and must be rewritten in the same delivery.
- ADR-0009's "No member scoping" no longer holds; its reasoning (MN-124) was about the ladder being authoritative, which this ADR keeps.
- Cost: one memoized existence query on every request for members in a workspace that has restricted something; zero for workspaces that have not.
- Risk, stated plainly: the guest model took months of leak fixes to reach its current shape (ticket #469, #474, #861, #881, #884, #880, #920, #909). Members inherit that work only where the code asks the primitives; **the sites that never ask** (the inventory's second half) are where the new leaks will be, which is why the coverage test is part of phase 1 and not a follow-up.
