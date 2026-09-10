---
title: Mentions and comment notifications
description: "@-mention a person, #-mention a record, in any rich text or comment — plus who finds out, and how to see who mentioned this record."
sidebar:
  order: 15
---

Type **@** for a person or **#** for a record, anywhere rich text or a comment accepts input. Both
open a picker; picking one inserts a chip.

## What a mention actually stores

A mention chip stores the **id**, not just the name you saw when you picked it — a label snapshot
rides along only as a fallback. That means:

- **Renaming the person or record updates every mention of them**, everywhere, automatically.
- **Deleting the mentioned thing degrades the chip to a tombstone** rather than leaving a stale,
  wrong name behind.
- Clicking a **#record** mention opens it in the split panel, the same as clicking a relation chip.

Mentions written by an agent over the API/MCP use the same markdown shape as the editor — a
link-style `@Name` whose target is `user:<id>` — so a mention an agent writes and one you type
render identically and point at the same id.

## Who finds out

Mentioning a person on a comment notifies them — the same in-app notification and email path
other activity uses. If the workspace has a **Slack connection**, the comment is also mirrored to
the workspace's default channel (not a per-user DM yet), reusing the exact same rendered text as
the in-app and email copies rather than a second, differently-worded version. This is best-effort:
if Slack isn't connected, or the send fails, the comment itself is unaffected — a comment must
never fail because Slack is down.

## Seeing who mentioned this record: "Mentioned in"

A record's panel shows a **Mentioned in** section — every *other* record whose comments or
rich text `#`-mention this one, with the true total in the heading (*"Mentioned in (101)"*, not
just however many have loaded).

- **Grouped by source database**, each group headed by its own name and count — *"Sprint Tasks
  (12)"*, *"Client Requests (4)"*. A group's count is only ever how many of the *loaded* rows are
  in it, not a second source of truth; the heading's overall total is still the one true count from
  the server. Groups appear in whatever order their database is first encountered, not
  alphabetically or re-sorted.
- **Loads past the first page.** Early on this silently capped at 100 with no signal a 101st
  existed; it now pages with a **Load more** button, and the heading's total comes from the
  server, not from counting what's rendered.
- **Guest-scoped like everything else.** A mention from a record in a database you cannot read
  never appears — not on the first page, not on any later one. If none of the mentions are visible
  to you, the section doesn't render at all rather than showing an empty heading.
- **Zero mentions** also renders nothing — no heading reading "(0)".

## A feed across many records: comments and references over time

**"Mentioned in" above answers a structural question** — what points at this one record, right
now. A different question is temporal: what's *happened* — every comment and every new
`#record` reference — across a whole database, or a whole hierarchy, in order. That's a
**feed**, API/MCP only today (no web page yet):

- `GET /workspaces/{ws}/databases/{db}/activity/comments` (`list_database_comments`) — every
  comment and reference across every record in **one database**, newest first, cursor-paginated.
  "What's been said across this database recently" without opening each record.
- `GET /workspaces/{ws}/databases/{db}/records/{rec}/activity/hierarchy?relation_field_ids=a,b,c`
  (`list_hierarchy_activity`) — the same feed, but rooted at **one record** and walked down a
  chain of relation fields you name, one **per level** — a different field each time, since each
  level lives on a different database (an Epic's own "Stories" field, then a Story's own "Tasks"
  field). Up to **5 levels**. Answers "everything that happened under this Epic, across every
  Story and Task under it" in one call, instead of one per database.

Both read the exact same two event kinds, so an entry looks and behaves identically either way:

- **`comment.created`** — which record, who/what wrote it, and a snippet of the comment.
- **`reference.created`** — which record now carries a new `#`-mention, and which record it
  points at. Only genuinely **new** mentions produce an entry: resaving content that still
  contains the same mention it already had doesn't re-emit one, since a mention is stored as a
  replace-the-whole-set write under the hood, not an append.

**Every entry carries `source`** (`human` / `agent` / `automation` / `mcp` / `null` if never
recorded) — the same attribution [record history](/concepts/record-history/) uses, never
defaulted to `human` just because most things are.

**A deleted comment, or a reference whose target record is gone, is left out of the feed** — an
`activity_events` row is an append-only log with no foreign key back to the comment or record it
describes, so a row can outlive the thing it points at; the feed skips rather than render a
dangling entry.

**The hierarchy walk only ever traverses what you can see.** A record the caller cannot access is
excluded from the walked set *before* the activity query runs, not fetched and then filtered out
— so its mere presence never leaks through a count or a timing difference. The root record being
invisible to you 404s the whole call, the same "don't confirm it exists" posture a personal view
already uses. A relation field that's missing, wrong-typed, or renamed simply ends the walk at
that level — you still get everything gathered up to there, not a rejected call. A **diamond**
(two different paths reaching the same descendant record) is deduped: that record's activity
counts once, not twice.

## Watching a record for changes

Mentions aren't the only thing that notifies. **Watching** a record gets you an email (and an
in-app notification) whenever any of its fields change — not just when someone mentions or
comments on it.

There is no button for this in the app today — no bell, no "Watch" menu item anywhere on a
record. `watch_record`, `unwatch_record`, and `list_watchers` exist only as [MCP tools](/mcp/tools/)
and raw API calls, so right now watching is something an agent does on your behalf, not something
you click. `watch_record` only subscribes the calling identity — an agent can't watch a record on
someone else's behalf.

When a watched record changes, the notification's body is a compact summary of exactly what
changed — `Status: To Do → In Progress · Owner: (empty) → Lena` — capped at five fields, with
"`· +N more`" appended if more than five changed in one save. Select and workflow fields show the
option's **label** in that summary, not its id. The email links straight to the record.

To keep a bulk edit from fanning out thousands of emails at once, **email delivery is capped at 50
recipients per change** — the in-app notification isn't capped, only the email side. A rule's
[automation](/concepts/automations/) actions can reference this same summary via a `{changesSummary}`
token, for something like posting "Status: To Do → In Progress" into a Slack message when a record
moves.

This respects the same **notification preferences** as everything else on this page — turning off
**Record changes** in **Settings → Notifications** stops the emails, the same as the other four
event types (assigned, mentions, comments, status changes) on that page. It defaults **on**.

## Over the API and MCP

`GET .../records/{id}/backlinks` returns `{data, total, has_more, next_cursor}` — the same
keyset-cursor shape [`query_records`](/api/querying/) uses. The MCP `list_backlinks` tool mirrors
it. Guest visibility is enforced on every page, including the count, not only the first one.
