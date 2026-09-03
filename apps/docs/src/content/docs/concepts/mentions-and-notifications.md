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
rich text `#`-mention this one, newest first, with the true total in the heading (*"Mentioned in
(101)"*, not just however many have loaded).

- **Loads past the first page.** Early on this silently capped at 100 with no signal a 101st
  existed; it now pages with a **Load more** button, and the heading's total comes from the
  server, not from counting what's rendered.
- **Guest-scoped like everything else.** A mention from a record in a database you cannot read
  never appears — not on the first page, not on any later one. If none of the mentions are visible
  to you, the section doesn't render at all rather than showing an empty heading.
- **Zero mentions** also renders nothing — no heading reading "(0)".

## Over the API and MCP

`GET .../records/{id}/backlinks` returns `{data, total, has_more, next_cursor}` — the same
keyset-cursor shape [`query_records`](/api/querying/) uses. The MCP `list_backlinks` tool mirrors
it. Guest visibility is enforced on every page, including the count, not only the first one.
