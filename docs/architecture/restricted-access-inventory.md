# Restricted access: inventory of every place that special-cases guests

Companion to [ADR-0018](../decisions/ADR-0018-restricted-spaces-and-databases.md) (ticket #923). Point-in-time, read from `main` at `40c5626a` on 2026-10-14. **This list is a proxy and will drift**; the ADR's access-coverage test is the mechanism, this is the starting checklist for it. Line numbers are as of that commit.

How to read it. There are three kinds of site, and they need three different fixes:

1. **Literal role branches**: `role !== 'guest'` early-returns. Each must become one shared predicate (`isNarrowed(membership)` in the ADR). Not fixed by changing a primitive.
2. **Member fast paths**: `member` returns `'creator'` before looking at any data. Fixed once the four `effectiveFor*` primitives learn about `restricted`; every caller of those is then fixed for free.
3. **Silent holes**: routes behind `@MinRole('member')` (or nothing) that take a space or database id and never ask access anything. A grep for guest cannot find these, so they are the dangerous half. Part 2 lists the ones found so far.

Risk: **H** leaks restricted content or its name if missed, **M** leaks metadata or only matters in a corner, **L** unaffected.

## Part 1. Code that already branches on role or calls the access primitives

### 1.1 The access core (`access/access.service.ts`)

| Line | Function | What it does | Change | Risk |
|---|---|---|---|---|
| 66-72 | `guestGrants` | Loads grants for a guest or bound token, memoized per request | Must also load for members. `guest-grant-memo.test.ts` and `record-grant-query-count.test.ts` pin the query count: keep the fast path to one cheap query | H |
| 97-156 | `boundTokenGrants` | One grant per listed entry: `'creator'` for an admin or member owner | **A member-owned bound token that lists a restricted entry must get the member's own grant, or nothing.** Literal `realRole === 'guest'` at 122/145/150. Without this a bound token bypasses restriction | H |
| 164-176 | `guestScopeIds` | The guest's grants as three allow-list id sets, pushed into SQL (activity) | Allow-list shape cannot express "everything unrestricted plus granted". Needs an `unrestricted` flag or an exclusion list | H |
| 187-205 | `canSeePersonal`, `notOthersPersonal*` | Personal space and view privacy | Role-agnostic. Compose with the new rule, do not change | L |
| 209-223 | `effectiveForDatabase` | Role for one database, null = 404 | Member fast path at 213-214. Check restricted on the database and its space | H |
| 234-252 | `effectiveForDatabases` | Batched, feeds `my_access` | Fast path 238-239. Same | H |
| 262-279 | `effectiveForRecord` | Database result plus record grant | Early return at 270 for non-guests: record grants must apply to members too | H |
| 294-317 | `effectiveForRecords` | Batched three-way max (activity hierarchy, mention narrowing) | Fast paths 298-299. Same | H |
| 339-374 | `visibleRecordIds` | Record-grant-only fallback for the entry gate | `role !== 'guest'` returns null. Generalize to "restricted and no broader grant" | H |
| 384-403 | `effectiveForSpace` | Space role; behind `assertSpace` and token minting | Fast paths 393-394. A database-scoped grant inside a restricted space makes the space visible but not editable | H |
| 410-423 | `assertBoundDatabaseReach` | Bound-token gate before a by-id lookup | Already role-agnostic | L |
| 426-442 | `assertSpace` | Space gate, 404 or boundary refusal | Fixed by `effectiveForSpace` | M |
| 445-455 | `guestVisibility` | Granted space and database id sets | Same shape problem as `guestScopeIds` | H |
| 458-470, 482-494 | `visibleSpaceIds`, `visibleDatabaseIds` | The sidebar door, and databases visible in full | A member gets all unrestricted plus granted, plus the parent space of a granted database | H |
| 506-510 | `guestRecordGrantIds` | Direct record grants, OR'd into cross-database queries | Return the member's record grants | H |
| 524-536 | `reachableDatabaseIds` | Visible databases plus those holding a granted record | Fixed by its two inputs | M |
| 557-577 | `isBillable`, `billableUserIds` | Seats. `isBillable` has no production caller (dead) | Decide whether a member holding only viewer grants is billable (ticket: today yes) | M |
| `mention-narrowing.interceptor.ts:27`, `mention-narrowing.service.ts:29` | Redacts @mention previews of unreadable records in every JSON response and in CSV export | Literal `role !== 'guest'` skip: a restricted member would be skipped | H |
| `grants.controller.ts:28` | Grant CRUD | Admin only. `createGrant` already accepts any member (no guest-only check) | Semantics: a grant on an open resource must not lower a member's rank | M |

### 1.2 Guard and auth

| Site | What it does | Change | Risk |
|---|---|---|---|
| `workspaces/workspace-access.guard.ts:65-76` | Downgrades a bound token to `role: 'guest'` and keeps the real role in `membership.bound` | The central place to introduce the predicate; a bound member is already treated as narrowed. This is the model to follow | H |
| `auth/auth.guard.ts:129-141` | `enforceResourceBinding`: a bound token reaches only `@ResourceScopable()` routes (14 routes) | An unbound restricted member has no such deny-by-default. Only those 14 routes were ever audited for narrowing | H |

### 1.3 Records (`records/records.service.ts`)

| Line | Function | Change | Risk |
|---|---|---|---|
| 297-316 | `attachLinks` | Literal `role === 'guest'` at 304 narrows record and chip titles | H |
| 340-370 | `attachLinksUnnarrowed` | Chip candidates, falls back to `visibleRecordIds`. A member who can read a record but not its restricted relation target must lose the chip | H |
| 2982-3078 | `assertRecordAccess`, `getByNumber` | Fixed by the primitives | M |
| 4877-4893 | `recordVisibilityCondition` | SQL row filter; literal 4881 | H |
| 4905-4985 | `titleNarrowedFor`, `titleHistoryRedacted`, `titleSqlFor`, `titleSqlForWorkspace`, `narrowTitlesDeep` | The ticket #884 computed-title narrowing; literals at 4923, 4933, 4944, 4970. `titleNarrowedFor` memo key uses `bound ? 'b' : 'g'`; a restricted member needs its own key part | H |
| 4994-5013 | `narrowTitles` | Literal 4995. Callers: activity (158, 310), favourites (146), search (338), records (313) | H |
| 5033-5113 | `narrowedQuerySurface` | The ticket #881 oracle defence (tainted rollups, lookups, formulas removed from filter, sort and aggregate). Literal 5044. Callers: aggregate 4527, grouped 4646, query 5128, title 4910 | H |
| 5129-5219 | `query`, `list` | Title expression and row visibility, via the helpers above | M |
| `records.controller.ts` 74-79, 350/362/402, 325-327 | `assertDb`, `GET/PATCH/DELETE :rec`, trash | Fixed by the primitives | M |

`narrowTitlesDeep` callers (all literal-guest today): `records.controller.ts` 101, 130, 213, 327, 392, 421, 463, 484; `mentions.controller.ts` 43; `notifications.controller.ts` 52; `relations.controller.ts` 183, 209.

### 1.4 Search

| Line | Function | Change | Risk |
|---|---|---|---|
| `search/search.controller.ts` 71-193 | `search` | Records, databases, spaces by name. **The spaces branch (171-180) runs only when `visible === null`**, so for a member it returns every space name including restricted ones | H |
| 195-274, 276-345 | `myWork`, `recent` | Via `reachableDatabaseIds`, `visibleRecordIds`, `narrowTitles` | M |

### 1.5 Databases, spaces, folders

| Site | Function | Change | Risk |
|---|---|---|---|
| `databases.service.ts:131-157` | `assertAccess` (about 45 call sites) | Fixed by the primitives | H |
| 166-173 | `assertCanMove` | Literal `role === 'guest'` → 403. **Keep**: guests cannot restructure | L |
| 210-235 | `list` | `guestVisibility` plus manual filter. A restricted database must be visible only through a grant | H |
| 318-341, 349-358 | `get`: far-side relation hiding and tainted-config redaction | A member must not learn the name of a restricted far-side database | H |
| **425-447** | **`create`** | **HOLE.** Only checks the space exists in the workspace; `@MinRole('member')`. A member can create a database inside a space they cannot see. Needs `assertSpace(space_id, 'creator')` | H |
| `workspaces/spaces.service.ts:24-37` | `list` | `visibleSpaceIds` + `notOthersPersonal` | H |
| **`workspaces.controller.ts:144-154`** | **`updateSpace`** (rename, reorder) | **HOLE.** `@MinRole('member')`, no scope check. Any member can rename a restricted space. The flag itself is admin-only in v1 | H |
| 156-171, 123-129, 177-183 | `deleteSpace` (has `assertSpace` creator), `createSpace`, `restoreSpace` (admin) | Fine | L |
| **`spaces/folders.controller.ts:35-60`; `folders.service.ts:13`** | **list, create, update, delete folders** | **HOLE.** `list` has no `MinRole` and no access check; the rest `@MinRole('member')`. `FoldersService.assertSpace` checks workspace membership only. Folder names of a restricted space leak | H |
| `spaces/groups.controller.ts:43-57` | Sidebar groups | Presentational by design | L |

### 1.6 Views, relations, mentions, activity, notifications, favourites, runs, approvals

| Site | Notes | Risk |
|---|---|---|
| `views/space-views.service.ts` (35-432) | `listForSpace`, `listPersonal`, `assertVisibleSpace`, `createForSpace`, `getById`, `removeById`, `updateById`, `moveToSpace`. All via `visibleSpaceIds` / `effectiveForDatabase` / `assertSpace`. **A code comment says "only guests can fail the per-database filter"; that assumption ends** (see `views-and-the-sidebar.md`) | H |
| `views/views.controller.ts`, `personal-filter`, `personal-collection-view` | `assertAccess`. Fixed by the primitives | M |
| `views/public-views.service.ts:204` | Anonymous published view, passes no membership, has its own allow-list redaction | L (see 2.3 for publish-time) |
| `relations/relations.service.ts` 320, 489-494, 562; `relations.controller.ts` (8 routes) | Schema graph edge dropped unless both sides readable; link list; write-side target check. All via `effectiveForDatabase` | H |
| `mentions/mentions.service.ts` 197-219, 243-267 | `assertBacklinksAccess`, `backlinks` via `visibleDatabaseIds` OR `guestRecordGrantIds` | H |
| `activity/activity.service.ts` 63-79, 98-195, 218-240, 262-367, 387-427 | `hiddenReferenceExclusion` (via `guestScopeIds`, a positive-set EXISTS), `listForRecord` (literal 146), `listCommentsForDatabase`, `buildFeed`, hierarchy | H |
| `notifications/notifications.service.ts:259-289` | `filterByAccess`, producer-side recipient filter that fails closed. **Its comment already says "restricted member"** | H |
| `favorites/favorites.service.ts` 54-59, 106-113 | Star only what you can read; list filtered | M |
| `runs/runs.service.ts` 68-89, 196-208, 317-331 | list, detail, rerun. `filters.q` at 92 matches `records.title` and `record_ref` returns it without `narrowTitles`: looks like an existing ticket #884 gap, independent of this work | H |
| `automations/approvals.service.ts` 359-376, 408-417 | list, `visibleToMembership` | H |
| `automations/approvals.controller.ts:65` | `assertHuman`: admin or named approver may decide, with no database access required (deliberate for guests, ticket #691) | M |
| `comments/comments.service.ts:112` | A mentioned user must be a non-guest. Mentionability, not narrowing; decide whether a member without access to the record is mentionable (delivery is already suppressed by `filterByAccess`) | M |

### 1.7 Everything else that narrows

| Site | Notes | Risk |
|---|---|---|
| `members/field-conversion.service.ts` 129-152, 161-183, 404-411 | The #597 "permission-neutrality" proof for converting a user field to a Members relation. **Its comment says "admin and member read the whole workspace already; only a GUEST can differ". That becomes false.** Literal guest queries at 131, 168, 405 | H |
| `fields/workflow-nomination.service.ts` 34-37, 121 | `visibleDatabaseIds`, `assertAccess` | M |
| `files/files.controller.ts:45-51` | `assertGuestHasAnyGrant`; files are workspace-wide and unscoped | L |
| `documents/space-documents.service.ts` | `assertSpace`. Edge: a database-only grant inside a restricted space gives no space-document access | M |
| `tokens/tokens.service.ts` 76-99 | Minting a bound token: the minter may bind only to what they can reach (`effectiveForSpace`, `effectiveForDatabase`). **Exactly the check a restricted member needs** | M |
| `packs/packs.service.ts` 428, 646-676 | `duplicateDatabase` creates in the same space: **the restricted flag must be copied** | M |
| `export/export.service.ts` 113-141 | CSV stream narrows mention previews through `MentionNarrowingService` | H |
| `copy-record`, `import`, `export`, `sources`, `validation-rules`, `buttons`, `documents`, `attachments` controllers | Per-database routes behind `assertAccess` / `assertRecordAccess` | M |
| `workspaces/invites.service.ts` 36-40, 81, 238-246 | **An invite carries grants only for guests, and accept creates grants only for guests.** A member invite must be able to carry grants to restricted resources | H |
| `billing/*`, `admin/admin-overview`, `admin/cost-attribution`, `sales-signal` | Seat counts via `billableUserIds` (admin or member = billable) | M |
| `agents/agent-principal.ts:28-35`, `tyron.service.ts`, `skills.service.ts` | Role → token scope ceiling, run owner scope. The agent's token goes through the API as that member, so restriction applies automatically | L |

### 1.8 Where the literal `'guest'` is NOT narrowing (exclude from the sweep)

Invites (`invites.service.ts`, `onboarding-nudge.service.ts`, `mail/templates.ts`), billing (`billing.service.ts`, `plans.ts`, `sales-signal.service.ts`, `members.service.ts`), schema and select-option labels (`db/schema.ts:37`, `members-db.service.ts`, `agents.service.ts:383`), seed and templates, and the many "find an admin to act as or notify" lookups (`referrals`, `tyron`, `entitlements`, `ai-credits`, `gdpr`, `github-actor`, `linear.service`, `action-gates`, `actions.service`).

## Part 2. Paths that never ask access at all (member assumed to see everything)

This is the half a grep cannot find. Found by four passes over the controllers and the services behind them; see 2.6 for what has **not** been read.

### 2.1 Notifications, watchers, mentions, e-mail, Slack

| Site | Exposes | Fix | Risk |
|---|---|---|---|
| `records.controller.ts:433-452`; `records.service.ts:3487-3515` | `POST/DELETE/GET .../records/:rec/watch(ers)`: any record id in the workspace, including one in a restricted database. A member subscribes, then receives change summaries; the watcher list is readable | Only `assertDb(:db)` runs and `recordId` is never tied to `:db`. Use `assertRecordAccess` and verify the record belongs to `:db` | H |
| `records.service.ts:3518-3580`; `watcher-email.service.ts:42-70` | `notifyWatchers`: e-mails the record title and a change summary to every stored watcher. The in-app notify filters access, **the e-mail is sent before and outside that filter**. Watchers persist after access is lost | Filter watcher ids through the access check at emit time; purge or ignore watchers when the flag flips | H |
| `notifications.service.ts:303-367` | `GET /notifications`, `unread-count`: stored snippet, title and database name of rows written before the flag flipped or a grant was revoked | Emit-time `filterByAccess` only; add a read-time check or purge on flip | H |
| `notifications.service.ts:259-262` | Notifications that carry no `databaseId` skip `filterByAccess`. `linear-write-back.service.ts:153` passes `recordId` without `databaseId` | Derive `databaseId` from `recordId` | M |
| `comments.service.ts:311-354` | `notifyMentions` e-mail and **Slack** post to the workspace default channel with record title, excerpt and deep link. Only the in-app notify is filtered | Filter e-mail recipients; suppress or generalize the Slack post for restricted records | H |
| `comments.service.ts:75-110` | `validateBody`: `@user` validated only as a non-guest active member, `#record` only as in the workspace | Check mentioned users' access; decide whether a restricted record can be mention-linked at all | M |
| `mentions.service.ts` (`syncRecordMentions`, `backlinks`) | Mentioning records in restricted databases; backlink rows written for any record in the workspace | `visibleDatabaseIds` returns null for members: apply the filter in the query | H |
| `space-documents.service.ts:311` | Moving a document out of Personal fires a `mentioned` notification with the title and no database or space context | Pass the space and check access | M |

### 2.2 Automations, approvals, webhooks

| Site | Exposes | Fix | Risk |
|---|---|---|---|
| `automations/actions.service.ts:247-295, 915, 1096-1200` | `validate` and `execute` for `create_record(s)` and `update_linked` write into **any database in the workspace** as the actor (rules, buttons, webhook triggers). `validate` checks the target exists in the workspace (289) and nothing else | Require access to the target at save time and at run time | H |
| `actions.service.ts:1224-1324` | `notify_user`, `send_webhook`, `send_slack_message` (and `send_email`, `http_request` via jobs) push record values, titles and tokens out. Rules run as the stored creator whose access is never re-checked | Re-validate the creator's access when the rule fires; **fail visibly** (run error plus notification) instead of silently skipping | H |
| `automations.service.ts:463-475` (`conditionDbFor`) | Compiles conditions against the far database of a relation; source-database creator check only | Check access to the far side | M |
| `approvals.service.ts:359-378` | `GET /approvals`: pending approvals with `action_snapshot` (record values) for restricted databases, up to 100 rows | Filter by effective access | H |
| `webhooks.service.ts:355-440` (`scan`) | A workspace-wide subscription (`database_id` null) delivers record values, title, database name and space id for **every database, restricted ones included**, to an external URL. Management is admin-only, delivery is unfiltered | Policy decision (ADR open question): exclude restricted databases from workspace-wide subscriptions | M |

### 2.3 Narrowing that depends on an optional argument, or unverified

| Site | Issue | Risk |
|---|---|---|
| `records.service.ts:297-300, 1424` | `attachLinks` narrows chips, lookups and rollups only when `membership` is passed (optional parameter) | M |
| `forms/forms.service.ts:357, 368, 600` | Public form target options and record read call `records.list/query/get` with no membership. Unverified | M |
| `views/public-views.service.ts:194, 279` | Published view query and aggregate pass no membership. Does publish require access, and does it unpublish or block when a database becomes restricted? | M |
| `records.service.ts:436-460` (`narrowComputedValues`) | Rollup and formula shadow values are computed over the full data and narrowed on output only. Does `query-compiler.ts` let sort, filter or aggregate read them (an inference channel, the ticket #881 class)? | M |

### 2.4 Content controllers: search, runs, views, folders, fields, templates, forms, relations, tokens, files

Second pass, 28 controllers and about 128 endpoints read. **Everything below that is marked "via primitives" is only safe once `effectiveFor*` and the guest-only helpers are restricted-aware**: their inputs are `{ id, spaceId }` partial selects with no restriction flag, so the fix cannot be a tweak at the call sites; AccessService must resolve the database and space restriction itself (it already reads the space row in `effectiveForSpace` for the personal check). A guest holding a space grant must also not inherit a restricted database inside it.

| Site | Exposes | Fix | Risk |
|---|---|---|---|
| `search/search.controller.ts:66-126, 165` `GET search` | Titles, `database_name`, `space_name` and colour of records and databases in restricted databases | `visibleDatabaseIds` is guest-only (null = all for members). Needs the member-capable set for records, databases and the places branch; `titleSqlForWorkspace` is guest-only too | H |
| `search.controller.ts:170-181` `places` | Names of restricted **spaces**: spaces are searched only when `visible === null`; the personal filter is also absent | Filter spaces by restricted-visible and `notOthersPersonal` | H |
| `search.controller.ts:204-250` `GET my-work` | Records, database names, field and option metadata from restricted databases where the user is assignee or creator, **including after losing access** | `reachableDatabaseIds` is null for members, so all databases are scanned. Restrict to databases still readable, for the `created` tab too | H |
| `search.controller.ts:279-337` `GET recent` | Title, database and space name of records the user once touched in a database they have since lost | Same | H |
| `runs/runs.service.ts:68-90, 129` `GET runs` | Rule names, trigger-record titles, errors, database ids of restricted automations; the `q` filter is a **title-search oracle** | `visibleDbIds` guest-only: add a restricted-aware predicate to the WHERE | H |
| `runs.service.ts:193-203` `GET runs/:id` | Full run detail, `recordRef`, jobs, approvals. **A run whose rule was deleted skips the check entirely** | Check by effective database role; orphan runs: admin only; 404 | H |
| `fields/workflow-nomination.service.ts:27-34` | Names of restricted databases, select field names and option labels | Filter by member-capable visibility | H |
| `calendar-sync/calendar-sync.controller.ts:25-29`; `.service.ts:128-160` `GET .../bindings` | Database name, space name, field names, `last_error`. **No `MinRole`: any member and any guest can read it. This is already a guest leak today.** | Filter by effective role, preferably admin-only | H |
| `views/space-views.service.ts:350-407` `PATCH views/:view` (`updateById`) | **Write path.** For a database-owned view it asserts only space-editor plus `assertVisibleSpace` and never checks the database: a member with space access but no grant on a restricted database in that space can rewrite its view config, and the full row comes back | Require `effectiveForDatabase` ≥ editor on the view's database (404 otherwise) | H |
| `space-views.service.ts:409-460` `move-to-space` | Same gap: moves a restricted database's dashboard into the space, exposing its config | Require editor on the source database | H |
| `space-views.service.ts:35-45, 178-188, 257-285` | `listForSpace`, `assertVisibleSpace`, `getById`: a restricted space's existence, views, config. The per-database filter is right; **the space door is not** (`visibleSpaceIds` is guest-only). `assertVisibleSpace` is also the door for create, update, move and remove | Make `assertVisibleSpace` restricted-aware | H |
| `spaces/folders.controller.ts:35-59`; `folders.service.ts:13-45` | Folder names of any space, **including other people's personal spaces and restricted ones**; any member can create, rename and delete folders there. Patch and delete work by folder id with no space check | Resolve the folder's space and run the same door check as `assertVisibleSpace`, plus editor for writes | H |
| `fields/fields.service.ts:896-921` (callers 1049, 1128) | **A creator on database A can build a lookup or rollup through a relation whose target is a restricted database B they cannot read, copying B's data into A.** `resolveRelationTargetDb` has no membership | Pass membership down; require viewer on the target (404 otherwise). Same for relation create | H |
| `templates/templates.service.ts:140-165` `apply` (relations) | `external_target_name` matches any workspace database by name and creates a relation to a restricted one without an access check; the "Skipped relation to X, no such database" note is an **existence oracle** | Resolve only among readable databases, require creator, and do not distinguish hidden from absent | M |
| `templates.service.ts:94-117` `apply` (`space_id`, default `spaces.list()[0]`) | Installs a database into any space, including a restricted one (`databases.create` does not call `assertSpace`) | `assertSpace(editor)`; the default space must come from a restricted-filtered list | M |
| `templates.service.ts:306-319` `DELETE templates/sample-data` | Hard-deletes tracked sample records and returns the count with no per-record or database check | Delete only where the caller has editor; report skipped ones without naming them | M |
| `fields/fields.service.ts:296-352` `GET .../fields/:field/usage` | The `formulas[]` list includes `display_name` and `database_id` of formula fields on **other** databases reached via relations, restricted ones included | Drop other-database entries the caller cannot read | M |
| `views/public-views.service.ts:195-215`; `views.service.ts:864-1000` | A public view with `include_relation_api_names` resolves relation-chip record titles from the target database, restricted or not, **for an anonymous visitor** (`records.query` has no membership) | Drop chips whose target is restricted at serve time; validate at share time | H |
| `forms/forms.service.ts:354-377` `GET public/forms/:token/relations/:field` | An anonymous visitor lists up to 20 record titles of the relation's target database | Treat a relation to a restricted target as unresolvable: drop it in `getDefinition`, 404 here, refuse in `submit` | H |
| `forms.service.ts:380-396` `POST .../relations/:field` | Anonymous **creation** of a record in a restricted target database | Same | H |
| `relations/auto-link.service.ts:206-262` (via `auto-link.subscriber.ts`) | On-write auto-link links an open-database write to restricted-database records by field match with no actor check; lookups and rollups on the writer's record then carry restricted data | Auto-link must skip a side whose other database the actor cannot read | M |
| `relations/relations.service.ts:659-700` (`LinksController.replace`) | `PUT .../links/:field` with an **empty** `record_ids`: `assertTargetAccess` runs only when `targetIds.length`, so a member who cannot read the target can wipe all links into it, including to hidden records | Assert target access always | M |
| `access/access.service.ts:97-156` `boundTokenGrants` | For a member or admin owner a bound token gets `creator` on each listed entry regardless of the owner's real access; owner access is checked only at mint time (`tokens.service.ts:82-96`). A token minted while the owner had a grant keeps `creator` after revocation; a token bound to an open space also gets `creator` on a restricted database inside it | Compute per request: drop any listed entry the owner cannot read now; stop space grants covering restricted child databases | H |
| `documents/space-documents.service.ts:289-318` `move` (personal to shared) | `notify` sends `mentioned` with the document title to every mentioned user without checking they can see the target space | Filter recipients by access to the target; suppress at emit | M |
| `files/files.controller.ts:34-69`; `files.service.ts:90-130, 139` | Editor-embedded files carry no record, database or space scope: any member who knows an id (or holds the capability URL) can fetch an image embedded in a restricted document | Nothing to scope to without a schema change: decision needed | L |
| `views.service.ts:864` / `public-views.service.ts:54` | A public link or portal for a restricted database, or for one later made restricted, is not re-evaluated | Policy needed (ADR open question 3) | M |

**Judged safe (verifiable):** record documents (`documents.controller.ts`: `assertRecordAccess` on every route); `attachments.controller.ts` (`assertRecordAccess`); space documents list, create, get, export, update, remove, `copyToPersonal` (via `assertSpace`, inherits the `effectiveForSpace` fix); `favorites.service.ts` (`effectiveForDatabase` per target, `narrowTitles`); `relations.controller.ts` (`assertAccess` on both databases; `listRelations` drops an edge unless both sides readable); `relations.service` `listLinks`, `addLinks`, `removeLinks` (target check; `visibleRecordIds` null for members returns empty, which works once the primitive is fixed); per-database `views.controller.ts` and `personal-filter` (`assertAccess`; personal controllers touch only the caller's own prefs); `listPersonal` and the database branch of `getById`; `fields.controller.ts` (creator on the database; the target-database gap is above); workflow-nomination `apply`; `validation-rules.controller.ts` (`MinRole('admin')` plus creator); `portal-recipients`, `portal-activity` (`MinRole('admin')`); `skills`, `public-skills` (reference no database, space or record); `tokens.controller.ts` list, revoke, create (create validates each scope entry through `effectiveForSpace`/`effectiveForDatabase`); `users/preferences.controller.ts`; `runs.controller.ts` `quota` (aggregate, no names) and `rerun` (`effectiveForRecord`); `spaces/groups.controller.ts` (presentational); `calendar-sync` writes (`MinRole('admin')`).

**Unsure (left as questions):** whether computed values through relations (lookups, rollups, formulas on an open-database record showing a restricted target's values) must be nulled for members as ticket #884 does for guests; whether a public form, public view or portal on a restricted database is refused, goes 404 when the database becomes restricted, or is an explicit admin act; whether files need a scope column or are accepted as unguessable capability URLs; whether calendar sync of a restricted database to Google is allowed; whether a personal copy of a document or view that outlives revoked access is intended; whether a space dashboard config naming restricted database ids is acceptable; and I found no `suggestions` endpoint in `search.controller.ts`.

### 2.5 Bulk operations, exports, integrations, agents, background jobs, workspaces module

Third pass (about 55 files). New findings only; items already in 2.1 to 2.5 are not repeated. **One central fix covers most of the creators:** `DatabasesService.create` (`databases.service.ts:425`) checks only that the space is in the workspace, so `assertSpace(creator)` **inside** it covers every caller at once (controller, templates, Shopify catalogue, packs, Linear, architect) instead of one per caller.

| Site | Exposes | Fix | Risk |
|---|---|---|---|
| `workspaces/spaces.service.ts:23` `GET spaces` | Restricted space names, ids, icons: `visibleSpaceIds` returns null for members | Add a restricted predicate to the base `where`, like `notOthersPersonal` | H |
| `spaces.service.ts:193, 216` `DELETE spaces/:space` | The confirm-name error lists the names and count of every contained database, restricted ones included; a member with space access can soft-delete a restricted database inside an unrestricted space | List and cascade only databases the caller can reach, or refuse (admin only) when a contained database is restricted and the caller has no grant | H |
| `spaces.service.ts:57` `create` | The returned slug gets a `_2` suffix when a restricted space has the same name: a collision with a hidden space is detectable | Acceptable if documented; otherwise disambiguate without a visible counter | L |
| `spaces/groups.service.ts:25` | A group holding only restricted spaces shows as an empty named group | Hide groups with no visible space, or document | L |
| `search/search.controller.ts:171` | The space-name branch is not filtered at all (and lacks `notOthersPersonal`); fixing `visibleDatabaseIds` fixes the records and databases branches but **not this one** | Filter spaces by the restricted predicate | H |
| `import/import.service.ts:209, 617` CSV import, relation column with `target_database_id` | The dry run reports matched and unmatched titles against a restricted database (an oracle); it also creates a relation field to it and links records. Only the source database gets `assertAccess` | `effectiveForDatabase` on the target before the index build and before `relationsService.create`; same for the existing-relation path at 206 | H |
| `import.service.ts:731`; `migration-framework/relation-linker.service.ts:16` | `RelationLinkerService.link` calls `addLinks` without a membership, so `assertTargetAccess` is skipped. The same helper serves copy-record, Linear sync, github-webhook and the Shopify catalogue | Require the actor's membership for human-initiated callers, or assert the target database explicitly | M |
| `copy-record/copy-record.service.ts:105-136`; `migration-framework/storyos-source-adapter.ts:143` | Source relation chips are read with no membership, then re-linked into the target: a copy can carry links to restricted records; the target relation's database is not checked either | Resolve link targets against the actor and drop unreachable ones | M |
| `packs/packs.service.ts:417` `POST databases/:db/duplicate` | A member with a grant on a restricted database duplicates its schema, views and up to 50 records into a new database that is **not restricted** | The duplicate must copy `restricted` and its grants, or duplicating a restricted source becomes admin-only. Same question for **move** (ADR §3) | H |
| `packs.service.ts:646-657`; `agents/architect.service.ts:204` | A pack or duplicate places databases by space **name**. Two spaces can share a name, so a duplicate from a restricted "Finance" space can land in, or create, an open "Finance" space | Place by space id for duplicate and same-workspace flows | M |
| `records/bulk-record-jobs.service.ts:110` (controller `records.controller.ts:279`) `GET .../batch-jobs/:id` | Any job in the workspace is readable through any database id the caller can see: status, failed record ids and messages, restorable version ids. `assertDb` checks `:db` and it is never compared to `job.databaseId` | Require `job.databaseId === :db` | M |
| `bulk-record-jobs.service.ts:120-164` durable job `tick` | `batchUpdate` and `batchDelete` run later under the stored `actorId`; access is checked only at enqueue, so a grant revoked or a database turned restricted meanwhile still lets the job finish | Re-resolve the actor's effective role per chunk; fail the chunk if null | M |
| `agents/agents.service.ts:1515, 1491` `applyProposedAction` | A managed AI run proposes `{database_id, record_id}` and the apply path reads and writes it. Authorization is token scope only (member maps to write); **no per-database or per-record check against the owner** | `effectiveForDatabase` on the owner's membership for the payload database; refuse when null | H |
| `agents/agents.service.ts:204` (the Runs database) | The Runs database is an ordinary workspace database readable by every member; its Steps can name record ids, titles and details from a restricted database | Restrict the Runs database to admins, or redact step detail for runs on restricted databases | H |
| `agents/trigger.subscriber.ts:56` | Fires an agent on writes to any database with no access check for the owner | Same owner-access check | M |
| `calendar-sync/calendar-sync.service.ts:80` | Record titles and dates of a bound database are pushed to Google Calendar; a bound database later restricted keeps syncing outward | Policy: admin-configured outbound integrations (calendar, Linear mirror, workspace webhooks) are decided explicitly in the ADR (§9) | L |
| `fields/fields.service.ts:1270` `removeDependentLookups` | Deleting a field or relation in an open database deletes lookup fields in a **restricted** database the caller cannot see | Refuse, or require admin, when the cascade crosses into a restricted database | M |
| `integrations/github-webhook.service.ts:375, 458` | A PR body with a StoryOS record URL is matched on workspace only; the PR is linked and `maybeBacklink` **posts the record title and URL as a GitHub PR comment**. Anyone who can open a PR can extract a restricted record's title, to GitHub | Skip restricted databases; never post titles of restricted records | H |
| `integrations/shopify-catalogue.service.ts:81` (body `space_id`) | Same space-existence oracle and writes into a hidden space | Covered by the central `DatabasesService.create` fix | H |
| `integrations/linear.service.ts:588-600` `ensureTeamPack` | Finds the Linear team's existing space and databases through raw workspace-wide queries, restricted ones included | Intentional if the admin restricted the mirror; otherwise a restricted database with a matching name gets mirrored into | L |
| `export/export.service.ts:61-79, 130-150` CSV | Relation cells are joined chips that may embed restricted titles; `narrow` handles rich text for guests only | Verify the shared record projection covers members once the rule lands | M |
| `records/rollup-invalidation.subscriber.ts:41`; `records/ai-field.subscriber.ts:122` | Lookup and rollup values are **materialized into records of an open database from a restricted one**; AI fields read stored values including those **and send them to the model provider** | Schema-level rule: forbid or redact lookups and rollups that cross a restricted boundary (ADR §9) | H |
| `workspaces/members.service.ts:124` `remove` | `access_grants` are not deleted when a member is removed (only GDPR anonymize does) | Delete grants on removal (ADR §8) | M |

**Judged safe:** workspace export and GDPR (admin-only, admin sees everything; **the zip carries no `restricted` marker, so restriction is lost on restore**: see Part 4); pack export, install, preview, installed, uninstall, submissions (`@MinRole('admin')`); billing, entitlements, usage (admin, totals only); onboarding nudge, activation, trial reminders; spaces trash and restore (admin); per-database controllers for sources, fields, views trash and restore, copy-record target, import source, export CSV (all `assertAccess`, safe once `effectiveForDatabase` is); sources service, write-back subscriber and sync tick (one database id, write as system); connections (credentials, names and providers only); integrations directory (booleans); GitHub reviews service; Slack service wrapper; Linear write-back (`renderCommentText` with user names only, so `#record` mentions collapse to a label); position-repair and title-local-backfill subscribers; Tyron (mints a token for the member and calls the API, so it inherits whatever the API enforces); members, invites, field-conversion; favourites; relations list; space views and documents lists (fixed by the central change **provided `visibleSpaceIds` changes in the same commit**); backup and restore (operator `pg_dump`, no API).

**Unsure:** whether moving a restricted database into an open space keeps the flag (today a member holding a grant could unrestrict it by move or duplicate); whether `/export/workspace.zip` needs `restricted` and grants; whether lookups, rollups, formulas, computed titles and relation chips from an open database into a restricted one stay readable (product decision, ADR §9); whether an auto-link write to an open database can link to a restricted record and show titles in activity; whether the Agents, Runs and Triggers pack becomes admin-only; Tyron thread history and approvals keep tool outputs after access is revoked; whether `databases.get`/`list` redact relation fields pointing at a restricted database; public view shares and forms on a restricted database (not read: look like public exposure); admin-to-member demotion visibility.

### 2.6 What is still NOT audited (the honest remainder)

Four passes read about 80 files of 116 service files plus all 73 controllers by route list. **Not read, or read only in part, so nothing is claimed about them:** `records.service.ts` batch internals; `forms/*` (submit path) and `portal/*` service bodies; `packs.service.ts` `install` and `uninstall`; the parts of `agents.service.ts` away from apply and the run record; `sources/providers/*` and `migration-framework/*` internals; `documents.service` and `attachments.service` internals; `seed/*`; `agents/architect-proposer.ts`; `agents/tyron/ceilings.ts`; `skills.service.ts` beyond line 450; `mail/*`; `calendar-sync` push and pull internals; `analytics`; `workspaces/spaces.service.ts` beyond what 2.6 covers; dashboard tile queries (database ids inside view config). **The access-coverage test in the ADR exists precisely so this remainder is closed by a build failure, not by another reading.**

## Part 3. Around the API: web, MCP, tests, docs, schema

### 3.1 Web (`apps/web/src`)

Most pickers and lists need nothing but the API's answer, because `useSpaces`, `useDatabases` and the sidebar are already scoped by the API. The exceptions:

| Site | Issue | Fix | Risk |
|---|---|---|---|
| `components/sidebar.tsx:122-123` and the gates at 385, 490-491, 671, 1759, 2403, 2486, 3067; `sidebar-view-row.tsx:44-161` | `canEdit = role !== 'guest'` gates new database, new space, drag and reorder | A member holding only `viewer` on a restricted space still sees "New database" and drag handles (the API refuses). Gate on per-space effective access. `sidebar.tsx:2705` already does it right with `atLeast(db.my_access, 'creator')` (ticket #752): copy that | M |
| `app/w/[ws]/s/[space]/page.tsx:76` | `canSeeAccessList = role !== 'guest'` fires `/members` and `/grants` and shows "Manage access" | **Existing bug**: `GrantsController` is `@MinRole('admin')`, so a plain member gets a 403 and the button opens a dialog doomed to 403. Make it `isAdmin` | M |
| `s/[space]/page.tsx:145, 277` | Static copy "Workspace members: admin or member, access to every non-personal space" | **False once a space can be restricted.** Must list only the members who can reach the space | M |
| `components/share-dialog.tsx` (mounted at `sidebar.tsx:1931`, `:2936`, `s/[space]/page.tsx:368`) | The existing Manage access UI: a static read-only "Members" section (`role !== 'guest'`), a "Guests" section of grant rows with a role dropdown and delete, "Add a guest" over `role === 'guest'` members only, and the copy *"Members and admins always have access — that's fixed… invite them as a guest instead"* | **Extend, do not replace.** Needs: Everyone / Restricted toggle, "people with access" over members and guests with roles, add-person over all members, "admins always have access" note, "a space grant opens its restricted databases" banner. Delete the quoted copy and the `FreeGuestTip` footer logic. `lib/guest-invite.unit.test.ts:52` asserts that file list | M |
| `app/w/[ws]/settings/members/page.tsx:533` | `<option value="member">Member — full access</option>` | False once a member can be restricted out; reword ("everything not restricted") | L |
| `settings/members/page.tsx:405-579` | The invite dialog offers grants and a space checklist only for `role === 'guest'` | A member invite carries no grants (see 3.5). If "invite a member straight into a restricted space" is wanted, this dialog and the invite schema both change | M |
| `components/command-palette.tsx:196`, `quick-add-fab.tsx:50-54` | "Create in…" lists every database including read-only ones | Pre-existing for viewers; filter to `atLeast(my_access, 'contributor')` | L |
| `components/entity/mentions.tsx:144` and 17 other `useMembers` callers | Assignee, user-field and @mention people pickers list every workspace member (`GET /members` is `@MinRole('member')`) | Offers people who cannot see a restricted database. Delivery is suppressed at emit by the API; a UI hint is optional | L |
| `components/views/dashboard-view.tsx:122-137` | Tile source picker; a tile pointing at a database that later becomes restricted must degrade | Omit vs placeholder (the ticket #349 rule: zero readable sources says so, never an empty grid) | M |
| `components/views/share-view-dialog.tsx` (`d/[db]/page.tsx:210`) | Publishes a public view | ADR open question 3: warn or refuse for a restricted database | M |
| `lib/queries.ts:7-51` | `Space` and `DatabaseSummary` types have no `restricted` | Add `restricted?: boolean` (admins get a lock badge). `DatabaseSummary` already carries `my_access` | L |
| `lib/access.ts` | `atLeast`, `EffectiveRole`, `GRANT_ROLES` ("must stay in lockstep with ACCESS_RANK") | Reuse unchanged; `GRANT_ROLES` is the dropdown for member grants too | L |
| `components/sidebar.tsx:144` | "Hide from my sidebar" (localStorage) | Cosmetic only; the copy must not be confused with restricted | L |

Already correct (use `my_access`): `d/[db]/page.tsx:54-55`, `record-detail.tsx:173-175`, `mentions.tsx:151`, `collection-section`, `copy-to-dialog`, `field-controls`, `edit-field-dialog`, `table-view`, `feed-view`.

Web tests to extend: `lib/access.unit.test.ts`, `lib/settings-nav.unit.test.ts`, `lib/guest-invite.unit.test.ts`, `copy-to-dialog.unit.test.ts`, `relation-cell.unit.test.ts`.

### 3.2 MCP (`packages/mcp`)

- **No MCP tool has its own access filtering.** Each resolves the workspace and database through the API and returns what the API says, so the read tools (about 191 registered, checked by regex) are fixed by the API change alone.
- `resolve.ts`: `resolveDatabase` throws "No database matches X … Available: …" built from the scoped list. Ticket #543 added a special message for bound tokens; an unbound restricted member now gets the plain message, which is misleading but not a leak. Consider "or you may lack access".
- **Governing exclusion:** `coverage.ts` has `/(POST|DELETE|PATCH) .*\/(grants|invites|members)(\/|$)/` (ticket #441, ADR-0010): writes to grants, invites and members have **no MCP tool at any scope**, because an agent that edits the grant set widens its own blast radius. `tools.test.ts:3843-3862` additionally fails any tool named like `(create|add|remove|revoke|delete|update|set|invite|grant)_…(member|grant|invite|role|access)`.
- **Parity the build needs, and a decision (ADR §3 phase 3):** `update_space` (`tools.ts:5168`) and `update_database` (5428) take no `restricted` input, and **`coverage.test.ts` will not catch that** (it is a PATCH on an endpoint that already has a tool: the silent-gap shape of ticket #397). Add `restricted` to both by hand (admin scope; setting `true` narrows, `false` widens), expose it on `list_spaces`, `list_databases`, `describe_database`. Adding or removing a person's access stays **human-only**, keeping the #441 exclusion (add a `coverage.ts` entry citing the new ticket). That is consistent with ADR-0010 and is this ADR's recommendation.
- Same PR must edit `coverage.ts`, `TOOL_SCOPE` and the `tools.test.ts` guard. Also review `share_view`, `publish_view`, `create_portal_recipient` (admin scope) for publishing a restricted database.
- Docs: `apps/docs/src/content/docs/mcp/tools.md:89`.

### 3.3 Tests: the twin checklist

141 API test files match a guest/grant grep. **There is no shared fixture**: `test/helpers/users.ts` has only `signUpUser` and `authed`; each file hand-rolls invite and accept (`makeGuest` in `guest-mutation-surface.test.ts:35`, `inviteGuest` in `guest-query-surface.test.ts:41`, `relation-chip-access.test.ts:38`, `notify-access-check.test.ts:51`; about 76 `role: 'guest'` occurrences). Build the restricted-member fixture once, in a new `test/helpers/members.ts` (invite as `member` with no grants, accept, flag the target restricted through the new API), not a fifth copy. Keep the "admin control in every test" pattern and add a **granted member who must still see**.

Each of these needs a twin:

- **Core:** `access.test.ts`, `permissions-epic.test.ts`, `contributor-rung.test.ts`, `record-scoped-grants.test.ts`, `database-list-my-access.test.ts`, `guest-grant-memo.test.ts`, `guest-mutation-surface.test.ts`, `guest-query-surface.test.ts`, `resource-bound-token.test.ts`, `workspaces.test.ts`, `seat-billing.test.ts`.
- **Read paths:** `record-list-query-visibility.test.ts`, `search.test.ts`, `search-record-scoped.test.ts`, `relation-chip-access.test.ts`, `relation-chip-record-scoped.test.ts`, `backlinks-record-scoped.test.ts`, `mentions.test.ts`, `mentions-backlinks-paging.test.ts`, `mention-narrowing.test.ts`, `collab-record-scoped.test.ts`, `activity-record-scoped.test.ts`, `activity-cursor-ties.test.ts`, `hierarchy-activity.test.ts`, `computed-title-narrowing.test.ts`, `computed-values-record-scoped.test.ts`, `documents-record-scoped.test.ts`, `sub-items-record-scoped.test.ts`, `export-record-scoped.test.ts`, `workspace-export.test.ts`, `attachments.test.ts`, `attachment-field.test.ts`, `files-access.test.ts`, `runs-record-scoped.test.ts`, `runs.test.ts`, `notify-access-check.test.ts`, `record-grant-query-count.test.ts` (it pins statement counts: the fast path must not regress), `list-relations.test.ts`, `space-views.test.ts`, `views.test.ts`, `personal-view-delete-access.test.ts`, `portal-view-scoping.test.ts`, `sidebar-groups-presentational.test.ts`, `sidebar-groups-real-schema.test.ts`, `approvals.test.ts`, `copy-record.test.ts`, `records-duplicate.test.ts`, `duplicate-comments-attachments.test.ts`, `records-grouped-aggregate*.test.ts`.
- **Peripheral:** `members-*.test.ts` (field conversion), `portal-recipients.test.ts`, `webhook-header-writeonly.test.ts`, `validation-rules.test.ts`, `workflow-nomination.test.ts`, `skills*.test.ts`, `personal-space.test.ts`, `gdpr*.test.ts`.
- **MCP:** `tools.test.ts:3843` guard and `coverage.test.ts`.

### 3.4 Docs to rewrite (same delivery)

| File | Statement |
|---|---|
| `apps/docs/.../concepts/access-and-roles.md:8, 3` | "Access … is workspace-wide with three roles, plus space scoping for guests" and the front-matter description |
| same `:26-34` | **"Members are workspace-wide by design — there's no per-space member restriction, and none is planned in the near term."** and the advice to invite them as a guest. This is the sentence the ADR reverses |
| same `:13-20, 118-134, 137-139` | Roles table ("Edit schema ✅", "Members can edit schema in v1"), the share-dialog description ("lists Members (workspace-wide, unconditional) separately from Guests"), PAT "same guest scoping" |
| `concepts/workspaces-spaces-databases.md:78-80`; `getting-started/what-is-storyos.md:40-41`, `concepts.md:14`, `quickstart.md:35`; `concepts/data-model.md:14, 33` | "the unit of guest access", "Guests & granular access" |
| `guides/client-portals.md:11-18, 142-152, 177-186, 200-211` | Guests as the way to limit access; add restricted members as the alternative |
| `api/authentication.md:56-58, 79-80`; `api/overview.md:21`; `api/build-an-mcp-server.md:40`; `mcp/overview.md:34`; `mcp/oauth.md:23` | "same guest scoping", "a bound token behaves like a guest" (ADR §5: intersected with the owner's reach) |
| `api/conventions.md:154`, `api/querying.md:68`, `concepts/mentions-and-notifications.md:48, 126` | "Guest access to unshared spaces returns 404", "a guest's counts", "Guest-scoped like everything else": broaden to any caller |
| `guides/removing-a-member.md:14-20`, `docs/security/data-subject-requests.md:16, 41` | Grants survive removal (see 3.5) |
| `docs/product/flows.md:28` | "role Member → … sees everything" (stale) |
| `docs/architecture/views-and-the-sidebar.md:185-200` | "`visibleSpaceIds`: `null` means full access (admin/member)" and **"Only guests can have partial access"** and the GUEST-fixture rule: both become false |
| `CLAUDE.md` (Views section) | "Only guests can have partial access, so a test without a GUEST fixture proves nothing": update with the restricted-member fixture rule |
| `docs/api/openapi.json`, `packages/sdk/src/generated/` | Regenerate, never hand-merge |

### 3.5 Schema and the places that assume grants belong only to guests

- `access_grants` (`schema.ts:237-302`): `user_id`, three nullable scope columns with the `access_grants_scope_xor` CHECK, three partial unique indexes. **Nothing in it is guest-specific, so member grants need no schema change.** Only the two flag columns do (next migration number is `0110`; run `db:generate`; check open PRs for `apps/api/drizzle/` first).
- `spaces` and `databases` get `restricted boolean not null default false`. Consider `CHECK (NOT (personal AND restricted))` on spaces; "not a system database" needs a service check.
- **`workspaces/invites.service.ts:81`** `grants: input.role === 'guest' ? input.grants : null` and **`:238`** (accept applies grants only for guests): a member invite's grants are **silently dropped** although `createInviteSchema` accepts `grants` for any role. A silent discard is the hazard class this project has hit before; fix either way.
- **`workspaces/members.service.ts:124-174` (`remove`) does not delete the person's `access_grants`.** It deletes the membership, personal views and personal space only; grants go only on GDPR anonymize (`gdpr.service.ts:537`). A removed-then-re-invited member's old grants become **live again**, and `list_grants` shows grants for people no longer in the workspace. Harmless while members ignore grants; **a real access path once restriction exists.** The build must delete grants on removal.
- A role change keeps grants (promoting a guest to a member leaves them dormant until something is restricted: ADR §8).
- `createGrant` already accepts a member as grantee and `validateScope` checks scope existence only; ADR §7 adds the record-scope rejection for members there.
- Workspace export: whether a `restricted` flag round-trips was not verified.

## Part 4. Decisions the inventory forced, and what is still open

Decided in [ADR-0018](../decisions/ADR-0018-restricted-spaces-and-databases.md):

- A restricted space closes its databases; a space grant opens them, **except a database that is itself flagged restricted (sticky, decided 2026-10-15)** (§3). A database restricted inside an open space stays closed.
- **One central guard for creators:** `assertSpace(creator)` inside `DatabasesService.create`, so templates, Shopify, packs, Linear and the architect are all covered at once (§4).
- Duplicating a restricted database copies `restricted` and its grants; moving one keeps the flag; a duplicate by a non-admin of a restricted source is allowed only if the caller holds a grant (§3).
- Who may set the flag, rename and manage: admin only in v1 (§6). MCP can set `restricted` but not add or remove people (§6).
- Members' record grants rejected in v1 (§7); grants deleted on member removal; a member invite's grants applied or rejected, never discarded (§8).
- Derived data (lookups, rollups, AI fields), outbound integrations and public sharing: policy in §9.

Answered 2026-10-15 (ADR "Open questions"): sticky restriction yes; admin-only management; no member record grants and no groups in v1; files stay capability URLs with a follow-up; **the export zip carries `restricted` and grants**; Tyron history kept and documented; named-approver rule unchanged; billing unchanged. Still open: admin-to-member demotion visibility.

## Counts

- Controllers: all 73 enumerated; about 45 read in depth across the passes. Endpoints judged: about 280.
- Files read: about 80 of 116 service files, plus the web (31 files branching on role), MCP (191 tools by regex), 141 API test files, 34 doc locations.
- Findings: Part 1 about 175 sites in 48 files (most fixed by the primitives); Part 2 about 75 rows, of which about 35 are High. **The Part 2 rows are the ones that were never narrowed for anyone**, and several (calendar bindings, folders, templates, the public form relation routes) are leaks for **guests today**.
