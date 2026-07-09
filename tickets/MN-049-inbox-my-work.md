---
id: MN-049
title: Notifications inbox + My Work — the reasons to open the app every morning
status: done
depends_on: [MN-045]
size: L
---

**Problem.** Mentions send an email (when SMTP is configured) and vanish; assignments are silent; nothing shows "everything on my plate" across databases. Linear's daily loop is Inbox → My Issues → work; without an equivalent loop, StoryOS stays a place people *check*, not a place they *live*.

## Research

- **Linear Inbox**: one stream of personally-relevant events (assigned, mentioned, replies, status changes on subscribed issues); unread markers; keyboard triage; snooze. My Issues: assigned/created/subscribed tabs, grouped by state.
- **Fibery**: notification bell + per-user "My space" of references.
- **Notion**: Inbox tab with mentions and comment replies; the simple read/unread model is enough.
- **Height/Asana**: assignment notifications drive >half of all opens — assignment is the #1 producer to get right.

**Synthesis:** notifications = a per-user persisted stream produced from events already flowing through the system (person-field changes, mentions, comments), with read state. My Work = one cross-database query "records where any user-field contains me". Polling, not websockets, for v1.

## Design

### Data model

```
notifications: id, user_id, workspace_id, type enum(assigned|mentioned|commented),
               database_id, record_id, actor_id, snippet text|null,
               read_at timestamptz|null, created_at
```
Index `(user_id, workspace_id, read_at, created_at desc)`. Retention: purge read > 90 days (piggyback on whatever daily worker exists first — MN-047's, else a boot-time sweep).

### Producers (hook existing paths, all skip `actor == recipient`)

1. **assigned** — RecordsService.update diff already computes changed fields: for user-type fields, notify newly-added user ids (diff old→new set). Also on create with user values.
2. **mentioned** — the comments service already parses mentions for email; add a notification per mentioned member (guests too, if they can see the record — check via AccessService before insert).
3. **commented** — new comment on a record notifies: the record's creator + everyone who previously commented (distinct actor set), minus the commenter, minus anyone already notified as mentioned. Capped at 20 recipients.

Producers write in the same transaction as their parent op (no lost notifications) but MUST be try/caught so a notification failure never fails the user's action — log and continue.

### API

- `GET /workspaces/:ws/notifications?cursor&unread_only` — newest first, joined with record title + database name/icon + actor (name/image).
- `POST /notifications/:id/read`, `POST /workspaces/:ws/notifications/read-all`.
- `GET /workspaces/:ws/notifications/unread-count` — cheap count for the badge (poll target).

### Inbox UI

- **Sidebar top-nav (revised per founder's Fibery screenshot):** a section above spaces with `Home` (workspace home), `Search` (MN-048 palette), `Inbox` with unread badge (99+ cap), `My Work`. Inbox badge polls every 60s via react-query `refetchInterval`, refetch on window focus. No header bell — the sidebar row IS the surface, like Fibery/Linear.
- Click → right-side panel (not a route — keeps context): rows = actor Avatar (MN-045), sentence ("**Max** assigned you · *Fix flaky test*", "**Dana** mentioned you · *Sprint 12*"), database chip, snippet for comments, relative time; unread = bold + dot. Click row → marks read + navigates to the record. Header: "Mark all read".
- Empty state: "You're all caught up 🎉".

### My Work (`/w/:ws/me`)

- Endpoint `GET /workspaces/:ws/my-work`: for each database visible to me (grant-scoped — same helper as MN-048) that has ≥1 user-type field, query records where any user field's JSONB value contains my id (`values->fieldId ? :me` / array contains for multi) and not deleted; return grouped `{database: {...}, records: [...]}`, records carry due-date-ish field if the database has a date field named/typed for it (v1 heuristic: first date field), sorted due-first-then-updated.
- Page: `My Work` lives in the same sidebar top-nav section. Sections per database (icon + name + count), rows = title, state chip if a select named State/Status exists, due date, click → record. Collapsible sections.
- This is intentionally a *server-defined* view, not a saved view — zero configuration, works day one for every member.

## Implementation plan

1. Migration + producers with tests (assign/unassign diff, mention incl. guest-visibility check, comment thread fan-out, self-action suppression, transactional-but-non-fatal behavior).
2. Endpoints + unread count; SDK regen.
3. Bell + panel UI with polling; mark-read flows.
4. My Work endpoint (JSONB containment across user fields, grant scoping) + page + sidebar link.
5. Browser-verify with two accounts (assign → other account's badge increments within a poll; mention → row renders with avatar and snippet; guest sees only granted content in both surfaces).

## Edge cases

- User removed from workspace → notifications remain but rows render "(former member)"; My Work obviously not reachable.
- Record deleted after notification → row renders struck-through, click shows "This record was deleted" toast, marks read.
- Bulk batch-edit (MN-050) assigning 200 records → cap: collapse per (actor, recipient, type) within 1 minute into one row with count ("assigned you 37 records") — producer buffers by upserting a recent identical notification and bumping a `count` column (add `count int default 1`).
- Guests: both surfaces filtered by grants; a guest's My Work only spans granted databases.

## Out of scope

Websockets/live push, email digests, snooze, per-record subscribe/unsubscribe (subscription model is a follow-up), mobile push, notification preferences page (one switch "email on mention" already exists implicitly via SMTP).

## Acceptance criteria

- [ ] Producers: assigned (diff-based), mentioned (visibility-checked), commented (thread fan-out, capped), never self, never fatal to the parent op — all tested
- [ ] Inbox panel: badge with 60s poll, unread styling, mark read / mark all, navigation, burst collapsing
- [ ] My Work: cross-database person-field query with grant scoping, due-date-aware sort, grouped page + sidebar entry
- [ ] Two-account browser verification incl. guest scoping
