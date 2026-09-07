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
"record changed" for yourself stops the emails. That preference defaults to **on**, and the API
enforces it correctly, but **Settings → Notifications has no toggle for it** — only the other four
event types (assigned, mentioned, commented, state changed) have a row there today. Until that's
added, turning it off means a direct API call (`PATCH` your notification preferences), not a
Settings click.

## Over the API and MCP

`GET .../records/{id}/backlinks` returns `{data, total, has_more, next_cursor}` — the same
keyset-cursor shape [`query_records`](/api/querying/) uses. The MCP `list_backlinks` tool mirrors
it. Guest visibility is enforced on every page, including the count, not only the first one.
